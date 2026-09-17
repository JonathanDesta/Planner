import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  validate,
  loadState,
  saveState,
  KEY,
  MIGRATION,
} from "../js/state.js";
import {
  atMinute,
  addDays,
  formatTime,
  sleepBounds,
  weekday,
  dateISO,
} from "../js/dates.js";
import {
  morningSteps,
  groomingSunday,
  startRun,
  finishStep,
  pauseRun,
  elapsedStep,
  routineBlocks,
  undoStep,
} from "../js/routines.js";
import {
  scheduleDay,
  unionIntervals,
  overlap,
  travelChain,
} from "../js/timeline.js";
import { travelBetween } from "../js/travel.js";
import { facilityHours } from "../js/facilities.js";
import {
  fetchCalendar,
  normalizeEvent,
  eventsForDate,
  mechanicsOverrides,
} from "../js/calendar.js";
import { workoutForDate } from "../js/workout.js";
import { plannerEntities } from "../js/state.js";
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) || null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};
const event = (date, id, start, end, location) => ({
  id,
  title: id,
  start: atMinute(date, start),
  end: atMinute(date, end),
  location,
});
function classes(date) {
  const day = weekday(date);
  if ([1, 3, 5].includes(day))
    return [event(date, "Lecture", 570, 620, "kersten")];
  if (![2, 4].includes(day)) return [];
  return [
    event(date, "Class one", 570, 650, "ryerson"),
    event(date, "Class two", 660, 740, "bslc"),
    event(date, "Seminar", 840, 920, "cobb"),
    ...(day === 2
      ? [event(date, "Evening class", 1110, 1160, "kersten")]
      : [event(date, "Laboratory", 930, 1100, "kersten")]),
  ];
}
test("exact routine budgets, sequence, two-week anchor and Sunday vacuum recurrence", () => {
  for (const [date, budget] of [
    ["2026-09-21", 70],
    ["2026-09-22", 80],
    ["2026-09-23", 70],
    ["2026-09-24", 108],
    ["2026-09-25", 70],
    ["2026-09-26", 80],
    ["2026-09-20", 110],
    ["2026-09-27", 82],
    ["2026-10-04", 110],
  ])
    assert.equal(
      morningSteps(date).reduce((n, s) => n + s.seconds / 60, 0),
      budget,
    );
  assert.equal(groomingSunday("2026-09-13"), false);
  const sunday = morningSteps("2026-09-20").map((s) => s.id);
  for (const [before, after] of [
    ["body-shave", "dry"],
    ["unibrow", "vitamin-c"],
    ["outfit", "nails"],
    ["nails", "vacuum"],
    ["vacuum", "day-bag"],
  ])
    assert(sunday.indexOf(before) < sunday.indexOf(after));
  for (const [date, bathroomEnd, routineEnd] of [
    ["2026-09-21", "6:10 AM", "6:25 AM"],
    ["2026-09-22", "6:20 AM", "6:35 AM"],
    ["2026-09-24", "6:48 AM", "7:03 AM"],
    ["2026-09-26", "6:20 AM", "6:35 AM"],
  ]) {
    const blocks = routineBlocks(date, atMinute(date, 315));
    assert.equal(
      formatTime(blocks.filter((s) => s.resource === "bathroom").at(-1).end),
      bathroomEnd,
    );
    assert.equal(formatTime(blocks.at(-1).end), routineEnd);
    assert(!blocks.some((s) => s.id === "morning:bathroom-wait"));
  }
});
test("hair is Thursday only; Tuesday, Thursday and Saturday shave once after the final shower exit before skincare", () => {
  for (let day = 0; day < 14; day++) {
    const date = addDays("2026-09-20", day),
      steps = morningSteps(date).map((s) => s.id),
      hair = weekday(date) === 4,
      shave = [2, 4, 6].includes(weekday(date));
    for (const id of [
      "shampoo",
      "masque",
      "rinse-masque",
      "leave-in",
      "jojoba",
      "hair-gel",
      "sponge",
    ])
      assert.equal(steps.includes(id), hair, `${date}: ${id}`);
    assert.equal(
      steps.filter((id) => id === "face-shave").length,
      shave ? 1 : 0,
      date,
    );
    assert(!steps.includes("step-out") && !steps.includes("step-in"), date);
    if (shave) {
      assert.equal(steps.indexOf("face-shave"), steps.indexOf("dry") + 1, date);
      assert(steps.indexOf("face-shave") < steps.indexOf("vitamin-c"), date);
    }
    if (hair) {
      assert(steps.indexOf("body-scrub") < steps.indexOf("rinse-masque"));
      assert(steps.indexOf("rinse-masque") < steps.indexOf("cold"));
      assert(steps.indexOf("sponge") < steps.indexOf("vitamin-c"));
    }
  }
});
test("timers survive reloads and pauses without auto-completing; corrections remain ordered", () => {
  let run = startRun("2026-09-22", 1000000);
  run = pauseRun(run, 1030000);
  run = JSON.parse(JSON.stringify(run));
  assert.equal(elapsedStep(run, 2000000), 30);
  run = pauseRun(run, 2030000);
  assert.equal(elapsedStep(run, 2040000), 40);
  assert.equal(run.index, 0);
  run = finishStep(run, 2040000);
  assert.equal(run.completed[0].seconds, 40);
  run = undoStep(run, 2050000);
  assert.equal(run.index, 0);
  assert.equal(run.completed.length, 0);
});
test("seven elapsed hours and identical wake time across daylight-saving changes", () => {
  for (const date of ["2026-10-31", "2026-11-01", "2027-03-13", "2027-03-14"]) {
    const b = sleepBounds(date);
    assert.equal(b.nextWake - b.bed, 420);
    assert.equal(formatTime(b.wake), "5:15 AM");
  }
  assert.equal(formatTime(sleepBounds("2026-10-31").bed), "11:15 PM");
  assert.equal(formatTime(sleepBounds("2027-03-13").bed), "9:15 PM");
  assert.throws(() => atMinute("2027-03-14", 150), /does not exist/);
});
test("campus transitions include doors once; home stops change the following origin", () => {
  assert.equal(travelBetween("grossman", "cathey").minutes, 5);
  assert.equal(travelBetween("cobb", "kersten").minutes, 8);
  assert.equal(travelBetween("ryerson", "bslc").minutes, 10);
  assert.equal(travelBetween("Unknown room", "kersten").unknown, true);
  const date = "2026-09-29",
    blocks = [
      event(date, "offsite", 600, 650, "ratner"),
      event(date, "home meeting", 720, 750, "grossman"),
      event(date, "class", 840, 900, "cobb"),
    ];
  const chain = travelChain(blocks, sleepBounds(date));
  assert.equal(
    chain.legs.find((l) => l.toId === "class").route.origin.id,
    "grossman",
  );
  assert.equal(chain.legs.filter((l) => l.toId === "home meeting").length, 1);
});
test("Tuesday fits a calibrated 136-minute B plus meals and walks without touching classes", () => {
  const date = "2026-09-29",
    events = classes(date),
    before = structuredClone(events);
  const r = scheduleDay({
    date,
    events,
    workout: {
      label: "Workout B",
      day: "tuesday",
      forecastSeconds: 8160,
      postChangeSeconds: 600,
      basis: "measured",
      visits: 1,
    },
  });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.unplaced.length, 0);
  assert.deepEqual(events, before);
  assert.equal(r.primary.filter((b) => b.type === "meal").length, 3);
  assert.equal(
    r.primary.find((b) => b.type === "workout").end -
      r.primary.find((b) => b.type === "workout").start,
    146,
  );
  const evening = r.primary.find((b) => b.id === "Evening class");
  assert.equal(formatTime(evening.start), "6:30 PM");
  for (const [i, a] of r.segments.entries())
    for (const b of r.segments.slice(i + 1))
      assert(!overlap(a, b), `${a.title} overlaps ${b.title}`);
});
test("unmeasured B remains visible without an unmeasured-session warning; measured conflicts are reported", () => {
  const date = "2026-09-29",
    w = {
      label: "Workout B",
      day: "tuesday",
      forecastSeconds: 20000,
      postChangeSeconds: 600,
      basis: "model",
      visits: 1,
    };
  const r = scheduleDay({ date, events: classes(date), workout: w });
  assert(r.unplaced.some((i) => i.type === "workout" && i.quiet));
  assert(!r.conflicts.some((c) => c.blockId === `workout:${date}`));
  const measured = scheduleDay({
    date,
    events: classes(date),
    workout: { ...w, basis: "measured" },
  });
  assert(measured.conflicts.some((c) => c.kind === "unplaced"));
});
test("dining follows summer, orientation and regular Saturday exceptions", () => {
  assert.equal(facilityHours("cathey", "2026-09-20").intervals.length, 0);
  assert.equal(facilityHours("baker", "2026-09-20").intervals.length, 3);
  assert.equal(
    formatTime(facilityHours("cathey", "2026-09-26").intervals[0][1]),
    "2:30 PM",
  );
  const saturday = scheduleDay({ date: "2026-10-03" });
  assert.equal(
    saturday.primary.find((b) => b.meal === "dinner").location,
    "woodlawn",
  );
  assert.equal(facilityHours("ratner", "2026-09-28").provisional, true);
});
test("bathroom overruns, impossible tasks and fixed overlaps remain visible", () => {
  const date = "2026-10-01",
    settings = defaults().settings;
  settings.routineDurations.toilet = 40 * 60;
  const r = scheduleDay({
    date,
    settings,
    commitments: [
      {
        id: "long",
        title: "Long task",
        date,
        duration: 1000,
        location: "ratner",
        fixedStart: null,
        earliest: 420,
        latest: 1320,
      },
    ],
  });
  assert(r.routine.some((s) => s.id === "morning:bathroom-wait"));
  assert(!r.conflicts.some((c) => c.kind === "resource"));
  assert(r.unplaced.some((i) => i.id === "long"));
  const overlapPlan = scheduleDay({
    date,
    events: [
      event(date, "a", 600, 680, "grossman"),
      event(date, "b", 650, 710, "grossman"),
    ],
  });
  assert(overlapPlan.conflicts.some((c) => c.kind === "overlap"));
  assert.deepEqual(
    unionIntervals([
      { start: 0, end: 10 },
      { start: 5, end: 20 },
    ]),
    [{ start: 0, end: 20 }],
  );
});
test("completed and active activities survive replanning, with flexible locations retained", () => {
  const date = "2026-09-29",
    c = {
      id: "task",
      date,
      title: "At home",
      duration: 20,
      fixedStart: null,
      earliest: 480,
      latest: 1300,
      location: "grossman",
    };
  const start = atMinute(date, 800) * 60000;
  const r = scheduleDay({
    date,
    commitments: [c],
    activities: {
      task: {
        status: "complete",
        startedAt: start,
        endedAt: start + 20 * 60000,
        location: "grossman",
      },
    },
    now: start + 60 * 60000,
  });
  const task = r.primary.find((b) => b.id === "task");
  assert(task.complete);
  assert.equal(task.start, start / 60000);
  assert.equal(task.location, "grossman");
});
test("calendar pagination, recurrence identity, declined/cancelled events and DST normalization", async () => {
  let calls = 0;
  const raw = (id) => ({
    id,
    summary: id,
    start: { dateTime: "2026-11-02T09:30:00-06:00" },
    end: { dateTime: "2026-11-02T10:20:00-06:00" },
  });
  const snapshot = await fetchCalendar({
    calendarId: "primary",
    from: "2026-11-01",
    until: "2026-11-29",
    token: "test",
    fetcher: async (url) => {
      calls++;
      return {
        ok: true,
        json: async () =>
          calls === 1
            ? { items: [raw("one")], nextPageToken: "next" }
            : {
                items: [raw("two"), { ...raw("deleted"), status: "cancelled" }],
              },
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(snapshot.events.length, 2);
  assert.equal(formatTime(snapshot.events[0].start), "9:30 AM");
  assert.notEqual(
    normalizeEvent(raw("same"), "a").id,
    normalizeEvent(raw("same"), "b").id,
  );
  assert.equal(
    normalizeEvent(
      {
        ...raw("declined"),
        attendees: [{ self: true, responseStatus: "declined" }],
      },
      "primary",
    ),
    null,
  );
  await assert.rejects(
    fetchCalendar({
      calendarId: "primary",
      from: "2026-11-01",
      until: "2026-11-29",
      token: "test",
      fetcher: async () => ({ ok: false, status: 401 }),
    }),
    /Cached events are preserved/,
  );
  const allDay = normalizeEvent(
    { id: "all", start: { date: "2026-11-01" }, end: { date: "2026-11-03" } },
    "primary",
  );
  assert.equal(
    eventsForDate({ primary: { events: [allDay] } }, "2026-11-03").length,
    0,
  );
  const mechanics = normalizeEvent(
    {
      ...raw("m"),
      summary: "Honors Mechanics",
      location: "Arranged ARR",
      recurringEventId: "course-series",
      start: { dateTime: "2026-09-29T18:30:00-05:00" },
      end: { dateTime: "2026-09-29T19:20:00-05:00" },
    },
    "primary",
  );
  assert.deepEqual(mechanicsOverrides([mechanics]), {
    "series:primary:course-series": "kersten",
  });
});
test("migration preserves old data and credentials while replacing obsolete schedule defaults", () => {
  const old = {
    settings: {
      googleClientId: "client",
      tomtomKey: "secret",
      wakeTime: "08:30",
    },
    routineLog: [{ date: "2026-09-01" }],
    nightLog: [{ date: "2026-09-01" }],
    dayPlans: {
      "2026-09-29": {
        tasks: [
          { id: "x", name: "Saved task", durMin: 45, location: "Library" },
        ],
      },
    },
  };
  const storage = memory({ day_cache_v1: JSON.stringify(old) }),
    loaded = loadState(storage);
  assert(loaded.migrated);
  assert(storage.getItem(MIGRATION));
  assert.equal(loaded.state.settings.wakeTime, "05:15");
  assert.equal(loaded.state.settings.googleClientId, "client");
  assert.equal(loaded.state.legacyHistory.night.length, 1);
  assert.equal(loaded.state.commitments[0].location, "Library");
  assert(!JSON.stringify(plannerEntities(loaded.state)).includes("secret"));
  const saved = saveState(storage, loaded.state);
  assert.throws(() => saveState(storage, loaded.state), /Another tab/);
  assert.equal(
    validate(JSON.parse(storage.getItem(KEY))).version,
    saved.version,
  );
});

test("Thursday retains alternate dining needed to fit the complete workout after lab", () => {
  const date = "2026-10-01";
  const result = scheduleDay({
    date,
    events: classes(date),
    workout: {
      label: "Workout C",
      day: "thursday",
      forecastSeconds: 4640,
      postChangeSeconds: 600,
      basis: "model",
      visits: 1,
    },
  });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.unplaced, []);
  assert.equal(
    result.primary.find((b) => b.meal === "dinner").location,
    "bartlett",
  );
  const gym = result.primary.find((b) => b.type === "workout");
  assert(Math.abs(gym.end - gym.start - 5240 / 60) < 0.0001);
  assert(gym.end <= atMinute(date, 1260));
  for (const [i, a] of result.segments.entries())
    for (const b of result.segments.slice(i + 1)) assert(!overlap(a, b));
});
test("fixed tasks preserve actual execution and overruns while future tasks move", () => {
  const date = "2026-09-28",
    startedAt = atMinute(date, 600) * 60000;
  const task = {
    id: "fixed",
    title: "Fixed task",
    date,
    fixedStart: 600,
    duration: 20,
    location: "grossman",
  };
  const result = scheduleDay({
    date,
    commitments: [task],
    now: startedAt + 40 * 60000,
    activities: {
      fixed: { status: "active", startedAt, location: "grossman" },
    },
  });
  const fixed = result.primary.find((b) => b.id === "fixed");
  assert(fixed.active);
  assert.equal(fixed.end - fixed.start, 40);
  const done = scheduleDay({
    date,
    commitments: [task],
    activities: {
      fixed: { status: "complete", startedAt, endedAt: startedAt + 12 * 60000 },
    },
  }).primary.find((b) => b.id === "fixed");
  assert(done.complete);
  assert.equal(done.end - done.start, 12);
});
test("home breaks are opt-in, include both journeys, and count as free time once", () => {
  const date = "2026-10-03",
    baseline = scheduleDay({ date });
  assert(!baseline.primary.some((b) => b.type === "home"));
  const home = scheduleDay({
    date,
    settings: { returnHomeDuringBreaks: true },
  });
  assert(home.primary.some((b) => b.type === "home"));
  assert.deepEqual(home.conflicts, []);
  const occupied = unionIntervals(
    home.segments.filter((b) => !["free", "home"].includes(b.type)),
  ).reduce((n, b) => n + b.end - b.start, 0);
  assert.equal(home.freeMinutes + occupied, home.bed - home.wake);
});
test("projected weeks retain Mon/Tue/Thu/Fri, one visit daily and four weekly", async () => {
  const { fresh } = await import("../../oly-tracker/src/training.js"),
    { buildPlannerFeed } = await import(
      "../../oly-tracker/src/planner-feed.js"
    ),
    { validateFeed } = await import("../js/workout.js");
  const feed = validateFeed(buildPlannerFeed(fresh("2026-09-28", "source")));
  for (let week = 1; week <= 12; week++) {
    const days = [];
    for (let n = 0; n < 7; n++) {
      const date = addDays("2026-09-28", week * 7 + n),
        w = workoutForDate(feed, date);
      if (w) {
        assert.equal(w.visits, 1);
        days.push(weekday(date));
      }
    }
    assert.deepEqual(days, [1, 2, 4, 5]);
  }
  const invalid = structuredClone(feed);
  invalid.entries[0].active = true;
  invalid.entries[0].activeRemainingSeconds = NaN;
  assert.throws(() => validateFeed(invalid), /invalid/);
});

test("every rotated calendar preserves four visits, recovery gaps and bench spacing across the year", async () => {
  const { fresh, deferDay } = await import("../../oly-tracker/src/training.js");
  const { buildPlannerFeed } = await import(
    "../../oly-tracker/src/planner-feed.js"
  );
  for (let rotation = 0; rotation < 7; rotation++) {
    const state = fresh("2026-12-28", "source");
    deferDay(state, "monday", addDays(state.weekStart, rotation));
    const feed = buildPlannerFeed(state);
    for (let week = 0; week < 52; week++) {
      const start = addDays(feed.repeatStart, 7 * week);
      const slots = Array.from({ length: 7 }, (_, n) =>
        workoutForDate(feed, addDays(start, n)),
      );
      assert.deepEqual(
        slots.map((s) => s?.day || null),
        ["monday", "tuesday", null, "thursday", "friday", null, null],
      );
      assert.equal(
        slots.filter(Boolean).reduce((n, s) => n + s.visits, 0),
        4,
      );
      const b = atMinute(slots[1].date, 780),
        d = atMinute(slots[4].date, 780);
      assert(d - b >= 71 * 60 && d - b <= 73 * 60);
      const nextB = atMinute(addDays(start, 8), 780);
      assert(nextB - d >= 95 * 60 && nextB - d <= 97 * 60);
    }
  }
});

test("a C session moved to Friday uses Friday availability instead of a Thursday evening preference", () => {
  const date = "2026-10-09";
  const result = scheduleDay({
    date,
    workout: {
      day: "thursday",
      label: "Workout C",
      forecastSeconds: 90 * 60,
      postChangeSeconds: 600,
      visits: 1,
      basis: "model",
    },
  });
  const visit = result.primary.find((b) => b.type === "workout");
  assert(visit);
  assert(visit.end <= atMinute(date, 17 * 60));
  assert.deepEqual(result.conflicts, []);
});

test("a late morning reserves the bathroom after cleaning and keeps an actual overrun visible", () => {
  const date = "2026-10-01",
    late = atMinute(date, 360) * 60000;
  let run = startRun(date, late);
  run = finishStep(run, late + 3 * 60000);
  run = finishStep(run, late + 6 * 60000);
  assert.equal(run.currentStartedAt, atMinute(date, 480) * 60000);
  assert.throws(() => finishStep(run, late + 7 * 60000), /reopens/);
  run = JSON.parse(JSON.stringify(run));
  assert.equal(elapsedStep(run, late + 30 * 60000), 0);
  const latePlan = scheduleDay({ date, run, now: late + 30 * 60000 });
  assert(latePlan.routine.some((b) => b.id === "morning:bathroom-wait"));
  assert(!latePlan.conflicts.some((c) => c.kind === "resource"));
  const early = atMinute(date, 315) * 60000;
  let overrun = startRun(date, early);
  overrun = finishStep(overrun, early + 3 * 60000);
  overrun = finishStep(overrun, early + 6 * 60000);
  assert(
    scheduleDay({
      date,
      run: overrun,
      now: atMinute(date, 430) * 60000,
    }).conflicts.some((c) => c.kind === "resource"),
  );
});

test("expired Google authorization needs explicit reconnection without exposing a stale token", async () => {
  const { GoogleAuth } = await import("../js/google-auth.js");
  const storage = memory(),
    auth = new GoogleAuth({ storage });
  auth.accept("synthetic-token", Date.now() + 3600000, false);
  assert.equal(auth.getToken(), "synthetic-token");
  auth.expiresAt = Date.now() + 30000;
  assert.equal(auth.getToken(), null);
  auth.disconnect();
  assert.equal(storage.getItem("campus_google_token_v1"), null);
});

test("overruns release contradicted earlier placements while recorded completion remains pinned", () => {
  const date = "2026-09-29",
    wake = atMinute(date, 315) * 60000,
    now = atMinute(date, 450) * 60000;
  const before = scheduleDay({ date, now: wake });
  const run = startRun(date, wake);
  const delayed = scheduleDay({ date, run, now, previous: before.primary });
  const breakfast = delayed.primary.find((b) => b.meal === "breakfast");
  assert(breakfast.start >= delayed.routine.at(-1).end);
  assert(!breakfast.earlierPlan);
  assert(!breakfast.complete);
  const old = before.primary.find((b) => b.meal === "breakfast");
  const recorded = scheduleDay({
    date,
    run,
    now,
    previous: before.primary,
    activities: {
      [old.id]: {
        status: "complete",
        startedAt: old.start * 60000,
        endedAt: old.end * 60000,
        location: old.location,
      },
    },
  });
  assert.equal(recorded.primary.find((b) => b.id === old.id).start, old.start);
  assert(recorded.conflicts.some((c) => c.kind === "overlap"));
});

test("weekday Oly feeds project B/C/A/D, retain shifted dates and include the taper Saturday bench", async () => {
  const { fresh, deferDay } = await import("../../oly-tracker/src/training.js");
  const { buildPlannerFeed } = await import(
    "../../oly-tracker/src/planner-feed.js"
  );
  const { validateFeed } = await import("../js/workout.js");
  for (let offset = 0; offset < 7; offset++) {
    const s = fresh("2026-12-28");
    deferDay(s, "tuesday", addDays(s.weekStart, offset));
    const feed = validateFeed(buildPlannerFeed(s));
    assert.deepEqual(
      feed.entries.map((e) => e.label),
      ["Workout B", "Workout C", "Workout A", "Workout D"],
    );
    for (let week = 0; week < 52; week++) {
      const start = addDays(feed.repeatStart, week * 7);
      const slots = Array.from({ length: 7 }, (_, i) =>
        workoutForDate(feed, addDays(start, i)),
      );
      assert.deepEqual(
        slots.map((x) => x?.label || null),
        ["Workout B", "Workout C", null, "Workout A", "Workout D", null, null],
      );
      const b = atMinute(slots[0].date, 780),
        d = atMinute(slots[4].date, 780),
        next = atMinute(addDays(start, 7), 780);
      assert(d - b >= 95 * 60 && d - b <= 97 * 60);
      assert(next - d >= 71 * 60 && next - d <= 73 * 60);
    }
  }
  const s = fresh("2026-09-28");
  s.training.week = 12;
  const feed = validateFeed(buildPlannerFeed(s));
  assert.equal(workoutForDate(feed, "2026-10-03").label, "Moderate bench");
  assert.equal(workoutForDate(feed, "2026-10-10").label, "Moderate bench");
  feed.repeatDays[0] = feed.repeatDays[1];
  assert.throws(() => validateFeed(feed), /calendar order/);
});

test("actual bench eligibility delays a planned workout and never forces it into an ineligible day", () => {
  const date = "2026-09-28",
    eligible = atMinute(date, 16 * 60),
    workout = {
      label: "Workout B",
      day: "tuesday",
      forecastSeconds: 3600,
      postChangeSeconds: 600,
      basis: "measured",
      visits: 1,
      notBefore: eligible * 60000,
    };
  const result = scheduleDay({ date, events: classes(date), workout });
  const gym = result.primary.find((b) => b.type === "workout");
  assert(gym, "The eligible afternoon workout should fit");
  assert(gym.start >= eligible);
  assert.equal(gym.end - gym.start, 70);
  const blocked = scheduleDay({
    date,
    events: classes(date),
    workout: { ...workout, notBefore: atMinute(addDays(date, 1), 600) * 60000 },
  });
  assert(!blocked.primary.some((b) => b.type === "workout"));
  assert(blocked.unplaced.some((b) => b.type === "workout"));
});
