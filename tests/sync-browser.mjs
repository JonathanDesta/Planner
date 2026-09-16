import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import { serve } from "../scripts/serve.js";
const server = serve(0);
await new Promise((r) => server.on("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const engine =
  process.env.PLANNER_BROWSER_ENGINE === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  ...(engine === chromium
    ? { channel: process.env.PLANNER_BROWSER_CHANNEL || "chrome" }
    : {}),
});
const files = [],
  errors = [];
async function request(url, options = {}) {
  const u = new URL(url);
  if (options.method === "POST") {
    const pieces = options.body.split(
      /Content-Type: application\/json[^\r]*\r\n\r\n/,
    );
    const metadata = JSON.parse(pieces[1].split("\r\n--")[0]),
      data = JSON.parse(pieces[2].split("\r\n--")[0]);
    const id = String(files.length);
    files.push({ id, appProperties: metadata.appProperties, data });
    return { id };
  }
  if (u.searchParams.get("alt") === "media")
    return files.find((f) => f.id === u.pathname.split("/").at(-1)).data;
  const offset = Number(u.searchParams.get("pageToken") || 0);
  return {
    files: files
      .slice(offset, offset + 2)
      .map(({ id, appProperties }) => ({ id, appProperties })),
    ...(offset + 2 < files.length ? { nextPageToken: String(offset + 2) } : {}),
  };
}
async function device() {
  const context = await browser.newContext();
  await context.route("**/sync-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Isolated sync test</title>",
    }),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("testDrive", request);
  await page.goto(`${base}/sync-fixture`);
  return page;
}
async function install(page, connected = true) {
  await page.evaluate(async (connected) => {
    const { DriveSync } = await import("/Planner/js/cloud-sync.js");
    window.connected = connected;
    window.journal = JSON.parse(localStorage.getItem("test-journal")) || {};
    window.testSync = new DriveSync({
      app: "browser-fixture",
      storage: localStorage,
      getSnapshot: () => journal,
      applySnapshot: (snapshot) => {
        journal = snapshot;
        localStorage.setItem("test-journal", JSON.stringify(journal));
      },
      hasLocalData: () => Object.keys(journal).length > 0,
      getToken: () => (window.connected ? "synthetic-token" : null),
      fetcher: async (url, options) => ({
        ok: true,
        json: async () => window.testDrive(url, options),
      }),
    });
    await testSync.ready;
    window.change = async (values, deleted = []) => {
      Object.assign(journal, values);
      for (const key of deleted) delete journal[key];
      localStorage.setItem("test-journal", JSON.stringify(journal));
      await testSync.capture();
      clearTimeout(testSync.timer);
    };
  }, connected);
}
try {
  const a = await device(),
    b = await device();
  await install(a);
  await install(b);
  await a.evaluate(async () => {
    await change({ shared: 1 });
    await testSync.sync();
  });
  await b.evaluate(() => testSync.sync());
  assert.equal(await b.evaluate(() => journal.shared), 1);
  await a.evaluate(async () => {
    connected = false;
    await change({ shared: 2, left: "kept" });
  });
  await b.evaluate(async () => {
    connected = false;
    await change({ shared: 3, right: "kept" });
  });
  // Browser restarts preserve the offline revision queue in IndexedDB.
  await a.reload();
  await install(a, false);
  assert(await a.evaluate(() => testSync.meta.revisions.length >= 2));
  assert.equal(
    await a.evaluate(() => localStorage.getItem("browser-fixture:sync:v1")),
    null,
  );
  await a.evaluate(() => testSync.sync());
  assert.match(await a.evaluate(() => testSync.status), /connect to sync/);
  await a.evaluate(async () => {
    connected = true;
    await testSync.sync();
  });
  await b.evaluate(async () => {
    connected = true;
    await testSync.sync();
  });
  assert.equal(await b.evaluate(() => testSync.conflicts.length), 1);
  assert.equal(await b.evaluate(() => journal.shared), 3);
  await b.evaluate(async () => {
    const c = testSync.conflicts[0];
    await testSync.resolve(
      c.key,
      c.variants.find((v) => v.value === 2).revision,
    );
  });
  await a.evaluate(() => testSync.sync());
  assert.deepEqual(await a.evaluate(() => journal), {
    shared: 2,
    left: "kept",
    right: "kept",
  });
  await b.evaluate(async () => {
    await change({}, ["left"]);
    await testSync.sync();
  });
  await a.evaluate(() => testSync.sync());
  assert.equal(await a.evaluate(() => "left" in journal), false);
  // Simultaneous captures cannot lose immutable revisions to storage write races.
  await a.evaluate(async () => {
    connected = false;
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => change({ ["queued" + n]: n })),
    );
  });
  await a.reload();
  await install(a);
  await a.evaluate(() => testSync.sync());
  await b.evaluate(() => testSync.sync());
  assert.equal(await b.evaluate(() => journal.queued19), 19);
  assert.deepEqual(errors, []);
  console.log(
    "Cross-device browser sync passed: IndexedDB reload, offline queue, paginated revisions, concurrent edits, explicit conflict resolution, deletion and rapid changes.",
  );
} finally {
  await browser.close();
  server.close();
}
