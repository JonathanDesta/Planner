import { weekday, dayDifference, dateISO, atMinute } from "./dates.js";
export const GROOMING_ANCHOR = "2026-09-20";
export function groomingSunday(date) {
  return (
    weekday(date) === 0 &&
    dayDifference(date, GROOMING_ANCHOR) >= 0 &&
    dayDifference(date, GROOMING_ANCHOR) % 14 === 0
  );
}
export function morningSteps(date, overrides = {}) {
  const hair = weekday(date) === 4,
    shave = [2, 4, 6].includes(weekday(date)),
    grooming = groomingSunday(date),
    steps = [];
  const step = (id, title, minutes, resource = "dorm", extra = {}) =>
    steps.push({
      id,
      title,
      seconds: Number.isFinite(overrides[id]) ? overrides[id] : minutes * 60,
      resource,
      ...extra,
    });
  step("bed", "Get out of bed and make the bed", 3);
  step("bathroom-trip", "Collect supplies and walk to the bathroom", 3);
  step("toilet", "Use the toilet", 10, "bathroom");
  step("brush", "Brush teeth", 2, "bathroom");
  step("tongue", "Scrape tongue", 1, "bathroom");
  step("listerine", "Rinse with Listerine", 1, "bathroom");
  step("water-floss", "Water floss", 3, "bathroom");
  step("retainer", "Clean retainer", 3, "bathroom");
  step("shower-prep", "Undress and prepare the shower", 2, "bathroom");
  if (hair) {
    step("shampoo", "Shampoo and wash hair", 6, "bathroom");
    step("masque", "Apply hair masque and detangle with comb", 7, "bathroom", {
      startsMasque: true,
    });
  }
  step("cleanse", "Facial cleanse", 2, "bathroom");
  step("body-scrub", "Full body scrub", 6, "bathroom");
  if (grooming)
    step(
      "body-shave",
      "Shave pubic and armpit hair in the shower",
      15,
      "bathroom",
    );
  if (hair) {
    step("rinse-masque", "Rinse out hair masque", 3, "bathroom", {
      endsMasque: true,
    });
  }
  step("cold", "Three-minute cold shower", 3, "bathroom", {
    minimumSeconds: 180,
  });
  step("dry", "Step out and dry off", 4, "bathroom");
  if (shave) step("face-shave", "Shave face · two passes", 10, "bathroom");
  if (hair) {
    step(
      "leave-in",
      "Leave-in conditioner and detangle with comb",
      5,
      "bathroom",
    );
    step("jojoba", "Apply jojoba oil", 2, "bathroom");
    step("hair-gel", "Apply styling gel", 2, "bathroom");
    step("sponge", "Style with curl sponge", 3, "bathroom");
  }
  if (grooming) step("unibrow", "Shave unibrow", 5, "bathroom");
  step("vitamin-c", "Apply vitamin C serum", 1, "bathroom");
  step("hyaluronic", "Apply hyaluronic acid", 1, "bathroom");
  step("sunscreen", "Apply sunscreen", 2, "bathroom");
  step("eyebrow-gel", "Apply eyebrow gel", 1, "bathroom");
  step("lotion", "Apply lotion", 3, "bathroom");
  step("deodorant", "Apply deodorant", 1, "bathroom");
  step("cologne", "Apply cologne", 1, "bathroom");
  step("cleanup", "Clean up and pack bathroom supplies", 2, "bathroom");
  step("return-room", "Walk back to the dorm room", 2);
  step("outfit", "Put on outfit", 5);
  if (grooming) step("nails", "Cut nails", 8);
  if (weekday(date) === 0) step("vacuum", "Vacuum the room", 12);
  step("day-bag", "Grab belongings for the day", 2);
  step("contingency", "Morning breathing room", 6, "dorm", { buffer: true });
  return steps;
}
export function startRun(date, now = Date.now(), overrides = {}) {
  return {
    schema: 1,
    id: crypto.randomUUID(),
    date,
    startedAt: now,
    index: 0,
    currentStartedAt: now,
    pausedAt: null,
    pausedMs: 0,
    steps: morningSteps(date, overrides),
    completed: [],
    finishedAt: null,
    masqueStartedAt: null,
  };
}
export function elapsedStep(run, now = Date.now()) {
  return Math.max(
    0,
    ((run.pausedAt ?? now) - run.currentStartedAt - run.pausedMs) / 1000,
  );
}
function bathroomStart(date, start, steps) {
  const duration = steps
    .filter((s) => s.resource === "bathroom")
    .reduce((n, s) => n + s.seconds / 60, 0);
  let begin = start;
  for (const [a, b] of [
    [420, 480],
    [855, 870],
  ]) {
    const closed = atMinute(date, a),
      opens = atMinute(date, b);
    if (begin < opens && begin + duration > closed) begin = opens;
  }
  return begin;
}
export function pauseRun(run, now = Date.now()) {
  const next = structuredClone(run);
  if (next.finishedAt) return next;
  if (now < next.currentStartedAt)
    throw Error(
      "The bathroom is not available yet. The step timer will start when it reopens.",
    );
  if (next.pausedAt !== null) {
    next.pausedMs += now - next.pausedAt;
    next.pausedAt = null;
  } else next.pausedAt = now;
  return next;
}
export function finishStep(run, now = Date.now(), skipped = false) {
  if (run.finishedAt || !run.steps[run.index])
    throw Error("This routine is already finished.");
  if (now < run.currentStartedAt && !skipped)
    throw Error("Wait until the bathroom reopens before starting this step.");
  const next = structuredClone(run),
    step = next.steps[next.index],
    elapsed = elapsedStep(next, now);
  if (!skipped && step.minimumSeconds && elapsed < step.minimumSeconds)
    throw Error(
      "The three-minute cold shower timer is still running. Use Skip if you did not complete it.",
    );
  next.completed.push({
    id: step.id,
    startedAt: Math.min(now, next.currentStartedAt),
    endedAt: now,
    seconds: elapsed,
    pausedMs: next.pausedMs,
    skipped,
  });
  if (step.startsMasque && !skipped) next.masqueStartedAt = now;
  if (step.endsMasque) next.masqueStartedAt = null;
  next.index++;
  next.currentStartedAt = now;
  next.pausedAt = null;
  next.pausedMs = 0;
  if (next.index === next.steps.findIndex((s) => s.resource === "bathroom"))
    next.currentStartedAt =
      bathroomStart(next.date, now / 60000, next.steps) * 60000;
  if (next.index === next.steps.length) next.finishedAt = now;
  return next;
}
export function undoStep(run, now = Date.now()) {
  if (!run.completed.length) return run;
  const next = structuredClone(run);
  next.completed.pop();
  next.index--;
  next.currentStartedAt = now;
  next.pausedAt = null;
  next.pausedMs = 0;
  next.finishedAt = null;
  next.masqueStartedAt =
    next.completed.some((s) => s.id === "masque" && !s.skipped) &&
    !next.completed.some((s) => s.id === "rinse-masque")
      ? next.completed.find((s) => s.id === "masque").endedAt
      : null;
  return next;
}
export function routineBlocks(
  date,
  start,
  run = null,
  now = Date.now(),
  overrides = {},
) {
  const steps = run?.date === date ? run.steps : morningSteps(date, overrides);
  let cursor = run?.date === date ? run.startedAt / 60000 : start;
  const firstBathroom = steps.findIndex((s) => s.resource === "bathroom");
  return steps.flatMap((step, index) => {
    const completed = run?.date === date ? run.completed[index] : null;
    const active = run?.date === date && !run.finishedAt && index === run.index;
    const duration = step.seconds / 60;
    const begin = completed
      ? completed.startedAt / 60000
      : active
        ? run.currentStartedAt / 60000
        : index === firstBathroom
          ? bathroomStart(date, cursor, steps)
          : cursor;
    const end = completed
      ? completed.endedAt / 60000
      : active
        ? Math.max(now / 60000, begin) +
          Math.max(0, step.seconds - elapsedStep(run, now)) / 60
        : begin + duration;
    const waiting =
      index === firstBathroom && begin > cursor
        ? [
            {
              id: "morning:bathroom-wait",
              title: "Wait for the bathroom to reopen",
              start: cursor,
              end: begin,
              type: "buffer",
              location: "grossman",
              resource: "dorm",
              fixed: true,
            },
          ]
        : [];
    cursor = end;
    return [
      ...waiting,
      {
        ...step,
        id: `morning:${step.id}`,
        start: begin,
        end,
        type: step.buffer ? "buffer" : "routine",
        location: "grossman",
        complete: !!completed,
        skipped: completed?.skipped || false,
        active,
        fixed: true,
      },
    ];
  });
}
export function migrateRun(old) {
  if (!old?.steps?.length || !Number.isFinite(old.startTs)) return null;
  const steps = old.steps.map((s, index) => ({
    id: s.id || `legacy-${index}`,
    title: s.name || "Previous routine step",
    seconds: s.targetSec || 60,
    resource: "bathroom",
  }));
  const completed = old.steps.slice(0, old.cur).map((s) => ({
    id: s.id,
    seconds: s.actualSec || s.targetSec || 60,
    skipped: s.status === "skipped",
    startedAt: s.startTs || old.startTs,
    endedAt:
      (s.startTs || old.startTs) + (s.actualSec || s.targetSec || 60) * 1000,
    pausedMs: 0,
  }));
  return {
    schema: 1,
    id: "migrated-morning",
    date: old.date || dateISO(old.startTs),
    startedAt: old.startTs,
    index: Math.min(old.cur || 0, steps.length),
    currentStartedAt: old.steps[old.cur]?.startTs || old.startTs,
    pausedAt: null,
    pausedMs: 0,
    steps,
    completed,
    finishedAt: old.cur >= steps.length ? completed.at(-1)?.endedAt : null,
    masqueStartedAt: null,
    legacy: true,
  };
}
