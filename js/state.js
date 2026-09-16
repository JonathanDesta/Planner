import { validDate, clockMinutes, atMinute, addDays } from "./dates.js";
import { migrateRun } from "./routines.js";
export const KEY = "planner_v2",
  BACKUP = "planner_v2_backup",
  MIGRATION = "planner_before_campus_v2";
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const assert = (ok, message) => {
  if (!ok)
    throw Error(
      `Saved data is invalid: ${message}. Existing copies are preserved.`,
    );
};
export function defaults() {
  return {
    schema: 2,
    version: 0,
    updatedAt: 0,
    settings: {
      wakeTime: "05:15",
      googleClientId: "",
      googleCalendarIds: ["primary"],
      defaultTravelMin: 15,
      workoutAppUrl: "https://jonathandesta.github.io/oly-tracker/",
      mealMinutes: { breakfast: 35, lunch: 45, dinner: 45 },
      routineDurations: {},
      places: {},
      routes: {},
      hours: [],
      locationOverrides: {},
    },
    commitments: [],
    runs: {},
    activities: {},
    routineHistory: [],
    calCache: {},
    legacyHistory: { morning: [], night: [] },
    legacyArchive: null,
  };
}
export function validate(data) {
  assert(
    object(data) &&
      data.schema === 2 &&
      Number.isInteger(data.version) &&
      data.version >= 0,
    "format",
  );
  const s = structuredClone(data);
  assert(
    object(s.settings) && clockMinutes(s.settings.wakeTime) !== null,
    "wake time",
  );
  assert(
    Array.isArray(s.settings.googleCalendarIds) &&
      s.settings.googleCalendarIds.every(
        (id) => typeof id === "string" && id.trim(),
      ),
    "calendar selection",
  );
  for (const key of [
    "routes",
    "places",
    "routineDurations",
    "locationOverrides",
    "mealMinutes",
  ])
    assert(object(s.settings[key]), key);
  assert(
    Object.values(s.settings.routineDurations).every(
      (v) => Number.isFinite(v) && v >= 10 && v <= 3600,
    ),
    "routine durations",
  );
  assert(
    s.settings.routineDurations.cold === undefined ||
      s.settings.routineDurations.cold === 180,
    "three-minute cold shower",
  );
  assert(
    Object.values(s.settings.mealMinutes).every(
      (v) => Number.isFinite(v) && v >= 5 && v <= 180,
    ),
    "meal durations",
  );
  assert(
    Object.values(s.settings.routes).every(
      (r) =>
        object(r) &&
        Number.isFinite(r.minutes) &&
        r.minutes > 0 &&
        r.minutes <= 240,
    ),
    "walking routes",
  );
  assert(
    Array.isArray(s.settings.hours) &&
      s.settings.hours.every(
        (h) =>
          object(h) &&
          typeof h.place === "string" &&
          validDate(h.from) &&
          validDate(h.until) &&
          h.from <= h.until &&
          Array.isArray(h.intervals) &&
          h.intervals.every(
            (i) =>
              Array.isArray(i) &&
              i.length === 2 &&
              Number.isFinite(i[0]) &&
              Number.isFinite(i[1]) &&
              i[0] >= 0 &&
              i[1] <= 1440 &&
              i[0] < i[1],
          ),
      ),
    "facility hours",
  );
  assert(Array.isArray(s.commitments), "commitments");
  const ids = new Set();
  for (const c of s.commitments) {
    assert(
      object(c) &&
        typeof c.id === "string" &&
        !ids.has(c.id) &&
        typeof c.title === "string" &&
        c.title.trim() &&
        validDate(c.date),
      "commitment identity",
    );
    ids.add(c.id);
    assert(
      Number.isFinite(c.duration) &&
        c.duration > 0 &&
        c.duration <= 1440 &&
        typeof c.location === "string",
      "commitment duration or location",
    );
    assert(
      c.fixedStart === null ||
        (Number.isFinite(c.fixedStart) &&
          c.fixedStart >= 0 &&
          c.fixedStart < 1440),
      "fixed commitment time",
    );
    if (c.fixedStart === null)
      assert(
        Number.isFinite(c.earliest) &&
          Number.isFinite(c.latest) &&
          c.earliest >= 0 &&
          c.latest <= 1440 &&
          c.earliest < c.latest,
        "flexible commitment window",
      );
  }
  for (const k of ["runs", "activities", "calCache"]) assert(object(s[k]), k);
  for (const run of Object.values(s.runs)) {
    assert(
      object(run) &&
        run.schema === 1 &&
        validDate(run.date) &&
        Array.isArray(run.steps) &&
        Array.isArray(run.completed) &&
        Number.isInteger(run.index) &&
        run.index >= 0 &&
        run.index <= run.steps.length &&
        run.completed.length === run.index,
      "morning progress",
    );
    assert(
      Number.isFinite(run.startedAt) &&
        Number.isFinite(run.currentStartedAt) &&
        Number.isFinite(run.pausedMs) &&
        run.pausedMs >= 0 &&
        (run.pausedAt === null || Number.isFinite(run.pausedAt)),
      "morning timer",
    );
    assert(
      run.steps.every(
        (step) =>
          typeof step.id === "string" &&
          typeof step.title === "string" &&
          Number.isFinite(step.seconds) &&
          step.seconds >= 0,
      ),
      "morning steps",
    );
  }
  for (const a of Object.values(s.activities))
    assert(
      object(a) &&
        ["active", "complete", "replan"].includes(a.status) &&
        (a.status === "replan" || Number.isFinite(a.startedAt)) &&
        (a.status !== "complete" ||
          (Number.isFinite(a.endedAt) && a.endedAt >= a.startedAt)),
      "activity progress",
    );
  assert(Array.isArray(s.routineHistory), "routine history");
  return s;
}
export function migrateLegacy(old, oldRun) {
  const s = defaults();
  s.legacyArchive = old || null;
  for (const key of [
    "googleClientId",
    "tomtomKey",
    "mapsApiKey",
    "workoutAppUrl",
  ])
    if (typeof old?.settings?.[key] === "string")
      s.settings[key] = old.settings[key];
  if (old?.settings?.googleCalendarIds?.length)
    s.settings.googleCalendarIds = old.settings.googleCalendarIds;
  s.legacyHistory = {
    morning: old?.routineLog || [],
    night: old?.nightLog || [],
  };
  for (const [date, plan] of Object.entries(old?.dayPlans || {})) {
    if (!validDate(date)) continue;
    for (const [index, c] of (plan.tasks || []).entries()) {
      const fixedStart = clockMinutes(c.fixedStart);
      s.commitments.push({
        id: `migrated:${date}:${c.id || index}`,
        date,
        title: c.name || c.title || "Saved commitment",
        location: c.location || "grossman",
        duration: Number.isFinite(c.durMin) && c.durMin > 0 ? c.durMin : 30,
        fixedStart,
        earliest: 315,
        latest: 1335,
      });
    }
  }
  const events = [];
  for (const [date, cache] of Object.entries(old?.calCache || {}))
    if (validDate(date))
      for (const e of cache.google || []) {
        if (!Number.isFinite(e.startMin) || !Number.isFinite(e.endMin))
          continue;
        events.push({
          id: `legacy:${date}:${e.id}`,
          title: e.title || "Calendar commitment",
          location: e.location || "",
          start: atMinute(date, e.startMin),
          end: atMinute(date, e.endMin),
          allDay: !!e.allDay,
          blocks: !e.allDay,
          source: "google",
          legacy: true,
          date,
        });
      }
  if (events.length)
    s.calCache.legacy = {
      events,
      updatedAt: Math.max(
        0,
        ...Object.values(old.calCache).map((c) => c.ts || 0),
      ),
      legacy: true,
    };
  const run = migrateRun(oldRun);
  if (run) s.runs[run.date] = run;
  return validate(s);
}
export function loadState(storage) {
  const errors = [];
  for (const key of [KEY, BACKUP]) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      return {
        state: validate(JSON.parse(raw)),
        recovered: key === BACKUP,
        message: errors.join(" "),
      };
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) throw Error(errors.join(" "));
  const raw = storage.getItem("day_cache_v1"),
    run = storage.getItem("day_morning_run_v1");
  if (raw || run) {
    storage.setItem(
      MIGRATION,
      JSON.stringify({
        savedAt: Date.now(),
        raw,
        run,
        nightRun: storage.getItem("day_night_run_v1"),
      }),
    );
    const state = migrateLegacy(
      raw ? JSON.parse(raw) : null,
      run ? JSON.parse(run) : null,
    );
    storage.setItem(KEY, JSON.stringify(state));
    return {
      state,
      migrated: true,
      message:
        "Previous data backed up. Campus defaults applied; past routines remain in your backup.",
    };
  }
  return { state: defaults(), message: "" };
}
export function saveState(storage, state, expectedVersion = state.version) {
  const old = storage.getItem(KEY);
  if (old) {
    try {
      const existing = validate(JSON.parse(old));
      if (existing.version !== expectedVersion)
        throw Error("Another tab changed Planner. Reload before editing.");
    } catch (e) {
      if (e.message.startsWith("Another")) throw e;
    }
  }
  const next = validate({
    ...state,
    version: expectedVersion + 1,
    updatedAt: Date.now(),
  });
  if (old) {
    try {
      validate(JSON.parse(old));
      storage.setItem(BACKUP, old);
    } catch (e) {
      if (e.name === "QuotaExceededError") throw e;
    }
  }
  storage.setItem(KEY, JSON.stringify(next));
  return next;
}
export function plannerEntities(state) {
  const s = state.settings,
    entities = {
      preferences: Object.fromEntries(
        Object.entries(s).filter(
          ([k]) => !["googleClientId", "tomtomKey", "mapsApiKey"].includes(k),
        ),
      ),
      legacyHistory: state.legacyHistory,
    };
  for (const c of state.commitments) entities[`commitment:${c.id}`] = c;
  for (const [date, r] of Object.entries(state.runs))
    entities[`routine:${date}`] = r;
  for (const [id, a] of Object.entries(state.activities))
    entities[`activity:${id}`] = a;
  for (const r of state.routineHistory)
    entities[`history:${r.id || r.date}`] = r;
  return entities;
}
export function adoptPlannerEntities(state, entities) {
  if (!object(entities.preferences))
    throw Error("Cloud preferences are missing; local data is preserved.");
  const pairs = (prefix) =>
    Object.entries(entities)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]);
  return validate({
    ...state,
    settings: { ...state.settings, ...entities.preferences },
    commitments: pairs("commitment:").map(([, v]) => v),
    runs: Object.fromEntries(pairs("routine:")),
    activities: Object.fromEntries(pairs("activity:")),
    routineHistory: pairs("history:").map(([, v]) => v),
    legacyHistory: entities.legacyHistory || state.legacyHistory,
  });
}
