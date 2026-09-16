import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { serve } from "../scripts/serve.js";
const server = serve(0);
await new Promise((r) => server.on("listening", r));
const base = `http://127.0.0.1:${server.address().port}`,
  url = `${base}/Planner/`;
const engine =
  process.env.PLANNER_BROWSER_ENGINE === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  ...(engine === chromium
    ? { channel: process.env.PLANNER_BROWSER_CHANNEL || "chrome" }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  timezoneId: "America/Chicago",
  reducedMotion: "reduce",
});
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await context.route("https://accounts.google.com/**", (route) => route.abort());
// No test ever writes to a real calendar or Drive account.
await context.route("https://www.googleapis.com/**", (route) =>
  route.fulfill({
    status: 401,
    contentType: "application/json",
    body: '{"error":"test authorization"}',
  }),
);
await fs.mkdir("test-results", { recursive: true });
const clickNav = (name) =>
  page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
try {
  await page.clock.install({ time: new Date("2026-09-29T05:15:00-05:00") });
  await page.goto(url);
  await page.getByRole("heading", { name: "Make room for today." }).waitFor();
  await page.evaluate(async () => {
    const { defaults } = await import("./js/state.js"),
      { atMinute, addDays, weekday } = await import("./js/dates.js");
    const s = defaults();
    s.version = 1;
    const events = [];
    const add = (date, title, a, b, location) =>
      events.push({
        id: `${date}:${title}`,
        title,
        start: atMinute(date, a),
        end: atMinute(date, b),
        location,
        source: "google",
        calendarId: "fixture",
        htmlLink: "https://calendar.google.com/",
      });
    for (let n = 0; n < 28; n++) {
      const date = addDays("2026-09-28", n),
        day = weekday(date);
      if ([1, 3, 5].includes(day))
        add(date, "Physics lecture", 570, 620, "kersten");
      if ([2, 4].includes(day)) {
        add(date, "Calculus", 570, 650, "ryerson");
        add(date, "Biology", 660, 740, "bslc");
        add(date, "Seminar", 840, 920, "cobb");
        if (day === 2) add(date, "Evening physics", 1110, 1160, "kersten");
        else add(date, "Physics laboratory", 930, 1100, "kersten");
      }
    }
    s.calCache.primary = {
      from: "2026-09-28",
      until: "2026-10-26",
      updatedAt: Date.now(),
      events,
    };
    localStorage.setItem("planner_v2", JSON.stringify(s));
    localStorage.removeItem("planner_placements_v2");
    const { fresh } = await import("/oly-tracker/src/training.js"),
      { dayPlan } = await import("/oly-tracker/src/prescription.js"),
      { calibrationDefaults, prescriptionSignature } = await import(
        "/oly-tracker/src/planner-feed.js"
      );
    const oly = fresh("2026-09-28");
    oly.version = 1;
    oly.calibration = calibrationDefaults();
    oly.calibration.observations.push({
      id: "browser-fixture-b",
      signature: prescriptionSignature(
        dayPlan(oly.training, "tuesday").sessions[0],
        oly.training,
      ),
      seconds: 8160,
      includesChange: false,
      source: "Browser test fixture",
    });
    localStorage.setItem("oly_program_v7", JSON.stringify(oly));
  });
  await page.reload();
  await page.locator('[data-block="workout:2026-09-29"]').waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(await page.locator(".notice.alert").count(), 0);
  await page.screenshot({
    path: "test-results/tuesday-mobile.png",
    fullPage: true,
  });
  const frame = page.frames().find((f) => f.url().includes("/oly-tracker/"));
  await frame.evaluate(() => {
    window.__iframeIdentity = "stable";
  });
  await clickNav("Morning");
  await page
    .getByRole("button", { name: "Start morning routine", exact: true })
    .click();
  await page.clock.fastForward(30000);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await page.locator("#morning-clock").textContent();
  await page.clock.fastForward(120000);
  assert.equal(await page.locator("#morning-clock").textContent(), paused);
  await page.reload();
  await clickNav("Morning");
  assert.equal(await page.locator("#morning-clock").textContent(), paused);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.clock.fastForward(180000);
  assert.match(
    await page.locator(".runner .eyebrow").textContent(),
    /STEP 1 OF/,
  );
  await page
    .getByRole("button", { name: "Done, next step", exact: true })
    .click();
  assert.match(
    await page.locator(".runner .eyebrow").textContent(),
    /STEP 2 OF/,
  );
  await page
    .getByRole("button", { name: "Undo last step", exact: true })
    .click();
  assert.match(
    await page.locator(".runner .eyebrow").textContent(),
    /STEP 1 OF/,
  );
  await page.screenshot({
    path: "test-results/morning-mobile.png",
    fullPage: true,
  });
  const currentFrame = page
    .frames()
    .find((f) => f.url().includes("/oly-tracker/"));
  await currentFrame.evaluate(() => {
    window.__iframeIdentity = "preserved";
  });
  await clickNav("Workout");
  await clickNav("Today");
  await page.getByRole("button", { name: "Refresh calendar and sync" }).click();
  assert.equal(
    await currentFrame.evaluate(() => window.__iframeIdentity),
    "preserved",
  );
  await page
    .getByRole("button", { name: "+ Add commitment", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What do you need to do?").fill("Pick up notebook");
  await dialog.getByLabel("Duration · minutes").fill("15");
  await dialog.getByLabel("Location", { exact: true }).fill("Grossman dorm");
  await dialog.getByLabel("Earliest start").fill("08:00");
  await dialog.getByLabel("Finish by").fill("09:00");
  await dialog
    .getByRole("button", { name: "Save commitment", exact: true })
    .click();
  const task = page
    .locator("details.block.task")
    .filter({ hasText: "Pick up notebook" });
  await task.locator("summary").click();
  await task.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog
    .getByLabel("What do you need to do?")
    .fill("Pick up notebook and pens");
  await dialog
    .getByRole("button", { name: "Save commitment", exact: true })
    .click();
  assert.equal(
    await page
      .locator("details.block.task")
      .filter({ hasText: "Pick up notebook and pens" })
      .count(),
    1,
  );
  await clickNav("Week");
  assert.equal(await page.locator(".week-card").count(), 7);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/week-desktop.png",
    fullPage: true,
  });
  await clickNav("Settings");
  await page.getByLabel("Everyday wake-up").fill("05:20");
  // Foreground refresh and a new feed must not wipe an unsaved settings form.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  assert.equal(await page.getByLabel("Everyday wake-up").inputValue(), "05:20");
  await page.getByLabel("Everyday wake-up").fill("05:15");
  await page
    .getByRole("button", { name: "Save daily timing", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 780 });
  await page.waitForFunction(
    () =>
      innerWidth === 320 && document.documentElement.scrollWidth <= innerWidth,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "test-results/settings-small-mobile.png",
    fullPage: true,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.evaluate(() => {
    window.beforeOfflineReload = true;
  });
  // WebKit's protocol-level offline flag rejects navigation before consulting
  // its worker. Stop the origin server to test a genuine cold cache load there.
  const localPort = server.address().port;
  if (engine === webkit) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } else await context.setOffline(true);
  await page.reload();
  assert.equal(
    await page.evaluate(() => window.beforeOfflineReload),
    undefined,
  );
  await page.getByRole("heading", { name: "Make room for today." }).waitFor();
  await clickNav("Morning");
  assert.match(
    await page.locator(".runner .eyebrow").textContent(),
    /STEP 1 OF/,
  );
  if (engine === webkit)
    await new Promise((resolve) =>
      server.listen(localPort, "127.0.0.1", resolve),
    );
  else await context.setOffline(false);
  const olyCaches = await page.evaluate(async () =>
    (await caches.keys()).filter((key) => key.startsWith("oly-")),
  );
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration(location.href);
    await reg.unregister();
  });
  await page.reload();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  assert.deepEqual(
    await page.evaluate(async () =>
      (await caches.keys()).filter((key) => key.startsWith("oly-")),
    ),
    olyCaches,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: mobile/desktop layouts, commitments, timer pause/reload/undo, stable iframe, unsaved edits, offline reload and cache isolation.",
  );
} finally {
  await browser.close();
  server.close();
}
