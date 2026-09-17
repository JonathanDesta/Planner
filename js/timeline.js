import {
  atMinute,
  sleepBounds,
  formatTime,
  dateISO,
  weekday,
} from "./dates.js";
import { routineBlocks } from "./routines.js";
import { travelBetween, resolvePlace } from "./travel.js";
import { facilityHours, insideHours } from "./facilities.js";

export const overlap = (a, b) => a.start < b.end && b.start < a.end;
const ordered = (blocks) =>
  blocks
    .slice()
    .sort(
      (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
    );
export function unionIntervals(intervals) {
  const result = [];
  for (const i of ordered(
    intervals.map((v, n) => ({ ...v, id: v.id || String(n) })),
  )) {
    if (i.end <= i.start) continue;
    const last = result.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else result.push({ start: i.start, end: i.end });
  }
  return result;
}
export function freeIntervals(blocks, from, until) {
  let cursor = from;
  const result = [];
  for (const b of unionIntervals(blocks)) {
    if (b.start > cursor)
      result.push({ start: cursor, end: Math.min(b.start, until) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= until) break;
  }
  if (cursor < until) result.push({ start: cursor, end: until });
  return result.filter((i) => i.end > i.start);
}
// Includes actual home stops and retains location through virtual commitments.
export function travelChain(
  blocks,
  bounds,
  settings = {},
  earlyArrival = false,
) {
  const legs = [],
    issues = [];
  let previous = {
      id: "wake",
      title: "Wake up",
      start: bounds.wake,
      end: bounds.wake,
      location: "grossman",
    },
    location = "grossman";
  const stops = ordered(
    blocks.filter((b) => b.type !== "travel" && b.type !== "free"),
  );
  stops.push({
    id: "bed-boundary",
    title: "Bedtime",
    start: bounds.bed,
    end: bounds.bed,
    location: "grossman",
    boundary: true,
  });
  for (const stop of stops) {
    const nextPlace = resolvePlace(stop.location, settings.places);
    const nextLocation = nextPlace.virtual ? location : stop.location;
    const route = travelBetween(location, nextLocation, settings);
    const early =
      earlyArrival &&
      stop.type === "event" &&
      stop.start - previous.end >= route.minutes + 5
        ? 5
        : 0;
    const end = stop.boundary
      ? previous.end + route.minutes
      : stop.start - early;
    const start = end - route.minutes;
    if (route.minutes)
      legs.push({
        id: `travel:${previous.id}:${stop.id}`,
        title: stop.boundary
          ? "Walk home"
          : `Walk to ${route.destination.label}`,
        start,
        end,
        type: "travel",
        location: nextLocation,
        route,
        toId: stop.id,
        fromId: previous.id,
      });
    if (early)
      legs.push({
        id: `arrival:${stop.id}`,
        title: "Arrive and settle in",
        start: stop.start - early,
        end: stop.start,
        type: "buffer",
        location: nextLocation,
      });
    const shortfall = stop.boundary ? end - bounds.bed : previous.end - start;
    if (shortfall > 0.01)
      issues.push({
        id: `reach:${previous.id}:${stop.id}`,
        blockId: stop.id,
        kind: "travel",
        minutes: Math.ceil(shortfall),
        message: `${stop.title}: ${Math.ceil(shortfall)} more minute${Math.ceil(shortfall) === 1 ? "" : "s"} needed after ${previous.title}${route.minutes ? `, including ${route.minutes} minutes door to door` : ""}.`,
      });
    previous = stop;
    location = nextLocation;
  }
  return { legs, issues };
}
function validInsertion(blocks, candidate, bounds, settings, baselineIssues) {
  if (
    candidate.start < bounds.wake ||
    candidate.end > bounds.bed ||
    blocks.some((b) => overlap(b, candidate))
  )
    return false;
  return travelChain([...blocks, candidate], bounds, settings).issues.every(
    (i) => baselineIssues.get(i.id) >= i.minutes,
  );
}
function candidates(item, blocks, context) {
  const { date, bounds, settings, previous } = context;
  const old = previous.find((b) => b.id === item.id);
  const issueMap = new Map(
    travelChain(blocks, bounds, settings).issues.map((i) => [i.id, i.minutes]),
  );
  const results = [];
  for (const [placeRank, location] of item.locations.entries()) {
    const hours =
      item.type === "meal" || item.type === "workout"
        ? facilityHours(location, date, settings.hours)
        : { intervals: [[bounds.wake, bounds.bed]], verified: true };
    for (const gap of freeIntervals(
      blocks,
      Math.max(item.from, bounds.wake),
      Math.min(item.until, bounds.bed),
    )) {
      const starts = new Set();
      // Five-minute grid plus exact boundaries, preferences, previous placement and
      // travel-adjusted edges. Exact edges are necessary for short campus gaps.
      for (
        let start = Math.ceil(gap.start / 5) * 5;
        start + item.duration <= gap.end;
        start += 5
      )
        starts.add(start);
      const before = ordered(blocks.filter((b) => b.end <= gap.start)).at(-1);
      const after = ordered(blocks.filter((b) => b.start >= gap.end))[0];
      const inbound = travelBetween(
        before?.location || "grossman",
        location,
        settings,
      ).minutes;
      const outbound = travelBetween(
        location,
        after?.location || "grossman",
        settings,
      ).minutes;
      [
        gap.start + inbound,
        gap.end - outbound - item.duration,
        item.preferred,
        old?.start,
        ...hours.intervals.map(([a]) => Math.max(a, gap.start + inbound)),
      ]
        .filter(Number.isFinite)
        .forEach((s) => starts.add(s));
      for (const start of starts) {
        const end = start + item.duration;
        if (
          start < gap.start ||
          end > gap.end ||
          start < item.from ||
          end > item.until ||
          !insideHours(start, end, hours)
        )
          continue;
        const candidate = {
          ...item,
          start,
          end,
          location,
          hours,
          fixed: false,
        };
        if (!validInsertion(blocks, candidate, bounds, settings, issueMap))
          continue;
        let score =
          Math.abs(start - item.preferred) * (item.type === "meal" ? 2 : 0.4) +
          placeRank * 1800 +
          inbound +
          outbound;
        if (old)
          score +=
            Math.abs(start - old.start) * 1.5 +
            (old.location === location ? 0 : 100);
        results.push({ block: candidate, score });
      }
    }
  }
  // Keep candidates from every feasible gap and dining location, not only the
  // nearest lunch time: a later gym block can depend on an earlier meal.
  results.sort(
    (a, b) =>
      a.score - b.score ||
      a.block.start - b.block.start ||
      a.block.location.localeCompare(b.block.location),
  );
  const diverse = new Map();
  for (const c of results) {
    const key = `${c.block.location}:${Math.floor((c.block.start - bounds.wake) / 30)}`;
    if (!diverse.has(key)) diverse.set(key, c);
  }
  const perLocation = item.locations.flatMap((location) =>
    results.filter((r) => r.block.location === location).slice(0, 2),
  );
  return [
    ...new Set([
      ...perLocation,
      ...[...new Set([...results.slice(0, 5), ...diverse.values()])].sort(
        (a, b) => a.score - b.score,
      ),
    ]),
  ].slice(0, 24);
}
function placeItems(items, fixed, context) {
  let beam = [{ blocks: fixed, unplaced: [], score: 0 }];
  for (const item of items) {
    const expanded = [];
    for (const option of beam) {
      for (const c of candidates(item, option.blocks, context))
        expanded.push({
          blocks: [...option.blocks, c.block],
          unplaced: option.unplaced,
          score: option.score + c.score,
        });
      expanded.push({
        blocks: option.blocks,
        unplaced: [...option.unplaced, item],
        score:
          option.score +
          (item.type === "meal"
            ? 1000000
            : item.type === "workout"
              ? 500000
              : 100000),
      });
    }
    expanded.sort((a, b) => a.score - b.score);
    // Retain alternate dining locations through intermediate search layers.
    // Otherwise many near-identical Cathey placements can crowd out the only
    // feasible dinner near Ratner before the workout is considered.
    const alternatives = new Map();
    for (const option of expanded) {
      const key =
        option.blocks
          .filter((b) => !b.fixed)
          .map((b) => `${b.id}:${b.location}`)
          .sort()
          .join("|") +
        option.unplaced
          .map((i) => i.id)
          .sort()
          .join("|");
      if (!alternatives.has(key)) alternatives.set(key, option);
    }
    beam = [
      ...new Set([
        ...Array.from(alternatives.values()).slice(0, 16),
        ...expanded,
      ]),
    ].slice(0, 32);
  }
  return beam[0];
}
export function scheduleDay({
  date,
  settings = {},
  events = [],
  commitments = [],
  workout = null,
  run = null,
  activities = {},
  previous = [],
  now = Date.now(),
}) {
  const bounds = sleepBounds(date, settings.wakeTime || "05:15"),
    conflicts = [],
    notes = [];
  const routine = routineBlocks(
    date,
    bounds.wake,
    run,
    now,
    settings.routineDurations,
  );
  const morningEnd = routine.at(-1)?.end || bounds.wake;
  const fixed = [
    ...routine,
    ...events
      .filter((e) => !e.allDay && e.blocks !== false)
      .map((e) => ({ ...e, fixed: true, type: "event" })),
  ];
  const local = commitments.filter((c) => c.date === date);
  for (const c of local.filter(
    (c) => c.fixedStart !== null && c.fixedStart !== undefined,
  )) {
    const activity = activities[c.id],
      started = ["complete", "active"].includes(activity?.status);
    const start = started
      ? activity.startedAt / 60000
      : atMinute(date, c.fixedStart);
    const end =
      activity?.status === "complete"
        ? activity.endedAt / 60000
        : activity?.status === "active"
          ? Math.max(now / 60000, start + c.duration)
          : start + c.duration;
    fixed.push({
      ...c,
      start,
      end,
      location: activity?.location || c.location,
      type: "task",
      fixed: true,
      active: activity?.status === "active",
      complete: activity?.status === "complete",
    });
  }
  const meals = [
    ["breakfast", "Breakfast", 35, 420, 660, 420],
    ["lunch", "Lunch", 45, 660, 930, 720],
    ["dinner", "Dinner", 45, 990, 1290, 1080],
  ].map(([id, title, duration, from, until, preferred]) => ({
    id: `meal:${date}:${id}`,
    meal: id,
    title,
    type: "meal",
    duration: settings.mealMinutes?.[id] || duration,
    from: Math.max(morningEnd, atMinute(date, from)),
    until: atMinute(date, until),
    preferred: Math.max(morningEnd + 5, atMinute(date, preferred)),
    locations: ["cathey", "woodlawn", "bartlett", "baker"],
  }));
  const items = [...meals];
  if (workout && !workout.complete) {
    const w = {
      ...workout,
      id: `workout:${date}`,
      title: workout.label || "Workout",
      type: "workout",
      locations: ["ratner"],
      location: "ratner",
      duration: (workout.forecastSeconds + workout.postChangeSeconds) / 60,
      from: Math.max(morningEnd, (workout.notBefore || 0) / 60000),
      until: bounds.bed,
      preferred: atMinute(
        date,
        weekday(date) === 2 ? 930 : weekday(date) === 4 ? 1140 : 660,
      ),
    };
    if (workout.active && workout.startedAt)
      fixed.push({
        ...w,
        start: workout.startedAt / 60000,
        end:
          now / 60000 +
          (workout.activeRemainingSeconds + workout.postChangeSeconds) / 60,
        active: true,
        fixed: true,
      });
    else if (workout.visits > 1) {
      notes.push(
        "Oly currently specifies multiple visits. Planner retains that work for review under your one-visit limit.",
      );
      w.requiresReview = true;
      items.push(w);
    } else items.push(w);
  } else if (workout?.complete && workout.startedAt && workout.endedAt)
    fixed.push({
      ...workout,
      id: `workout:${date}`,
      title: workout.label,
      type: "workout",
      location: "ratner",
      start: workout.startedAt / 60000,
      end: workout.endedAt / 60000,
      complete: true,
      fixed: true,
    });
  for (const c of local.filter(
    (c) => c.fixedStart === null || c.fixedStart === undefined,
  ))
    items.push({
      ...c,
      type: "task",
      locations: [c.location || "grossman"],
      from: Math.max(morningEnd, atMinute(date, c.earliest ?? 315)),
      until: Math.min(bounds.bed, atMinute(date, c.latest ?? 1335)),
      preferred: atMinute(date, c.earliest ?? 720),
    });
  const pending = [];
  for (const item of items) {
    const activity = activities[item.id];
    const old = previous.find(
      (p) =>
        p.id === item.id &&
        (!p.fixed || p.earlierPlan) &&
        p.start <= now / 60000 &&
        date === dateISO(now),
    );
    if (activity?.status === "complete" || activity?.status === "active") {
      const start = activity.startedAt / 60000,
        end =
          activity.status === "complete"
            ? activity.endedAt / 60000
            : Math.max(now / 60000, start + item.duration);
      fixed.push({
        ...item,
        start,
        end,
        location: activity.location || old?.location || item.locations[0],
        fixed: true,
        complete: activity.status === "complete",
        active: activity.status === "active",
      });
    } else if (
      old &&
      activity?.status !== "replan" &&
      validInsertion(
        fixed,
        old,
        bounds,
        settings,
        new Map(
          travelChain(fixed, bounds, settings).issues.map((issue) => [
            issue.id,
            issue.minutes,
          ]),
        ),
      )
    )
      fixed.push({ ...old, fixed: true, earlierPlan: true });
    else {
      if ((old || activity?.status === "replan") && date === dateISO(now))
        item.from = Math.max(item.from, now / 60000);
      pending.push(item);
    }
  }
  const review = pending.filter((i) => i.requiresReview);
  const solvable = pending.filter((i) => !i.requiresReview);
  // Explore both meal-first and workout-first placements, selecting the solution
  // that fits the most required work, then minimizes fallback dining and movement.
  const context = { date, bounds, settings, previous };
  const orders = [
    solvable,
    [...solvable].sort(
      (a, b) =>
        (a.type === "workout" ? -1 : 0) - (b.type === "workout" ? -1 : 0),
    ),
  ];
  const solutions = orders
    .map((order) => placeItems(order, fixed, context))
    .sort((a, b) => a.score - b.score);
  const best = solutions[0];
  // A stated home-break preference, evaluated only after both journeys fit.
  // Never infer a return solely from a gap's length or steal a required block.
  if (settings.returnHomeDuringBreaks === true) {
    const stops = ordered(best.blocks);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i],
        b = stops[i + 1];
      if (
        resolvePlace(a.location).id === "grossman" ||
        resolvePlace(a.location).virtual ||
        resolvePlace(b.location).virtual
      )
        continue;
      const inbound = travelBetween(a.location, "grossman", settings).minutes;
      const outbound = travelBetween("grossman", b.location, settings).minutes;
      const start = a.end + inbound,
        end = b.start - outbound - (b.type === "event" ? 5 : 0);
      if (end - start < 30) continue;
      const home = {
        id: `home-break:${a.id}:${b.id}`,
        title: "Free time at the dorm",
        start,
        end,
        type: "home",
        location: "grossman",
        fixed: false,
      };
      const issues = new Map(
        travelChain(best.blocks, bounds, settings).issues.map((x) => [
          x.id,
          x.minutes,
        ]),
      );
      if (validInsertion(best.blocks, home, bounds, settings, issues))
        best.blocks.push(home);
    }
  }
  const chain = travelChain(best.blocks, bounds, settings, true);
  conflicts.push(...chain.issues);
  const primary = ordered(best.blocks);
  for (let i = 0; i < primary.length; i++) {
    const a = primary[i];
    if (a.start < bounds.wake || a.end > bounds.bed)
      conflicts.push({
        id: `sleep:${a.id}`,
        blockId: a.id,
        kind: "sleep",
        message: `${a.title} overlaps the protected seven-hour sleep window.`,
      });
    if (a.resource === "bathroom")
      for (const [start, end] of [
        [420, 480],
        [855, 870],
      ])
        if (
          overlap(a, { start: atMinute(date, start), end: atMinute(date, end) })
        )
          conflicts.push({
            id: `bathroom:${a.id}`,
            blockId: a.id,
            kind: "resource",
            message: `${a.title} overlaps bathroom cleaning (${formatTime(atMinute(date, start))}–${formatTime(atMinute(date, end))}).`,
          });
    if (
      ["meal", "workout"].includes(a.type) &&
      !a.complete &&
      !insideHours(
        a.start,
        a.end,
        facilityHours(a.location, date, settings.hours),
      )
    )
      conflicts.push({
        id: `hours:${a.id}`,
        blockId: a.id,
        kind: "hours",
        message: `${a.title} falls outside the available facility hours.`,
      });
    for (const b of primary.slice(i + 1))
      if (overlap(a, b))
        conflicts.push({
          id: `overlap:${a.id}:${b.id}`,
          blockId: b.id,
          kind: "overlap",
          message: `${a.title} overlaps ${b.title}.`,
        });
  }
  const unplaced = [...best.unplaced, ...review].map((item) => {
    let largest = 0;
    if (
      item.type === "workout" &&
      item.basis !== "model" &&
      !item.requiresReview
    ) {
      // Diagnostic capacity may reposition meals, but never changes the actual
      // workout prescription or the returned schedule. Preserve other required
      // items and use the same travel/hour constraints as the complete search.
      let low = 0,
        high = Math.ceil(item.duration);
      const alreadyUnplaced = new Set(
        best.unplaced.filter((i) => i.id !== item.id).map((i) => i.id),
      );
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        const fits = orders.some((order) =>
          placeItems(
            order.map((i) => (i.id === item.id ? { ...i, duration: mid } : i)),
            fixed,
            context,
          ).unplaced.every((i) => alreadyUnplaced.has(i.id)),
        );
        if (fits) low = mid;
        else high = mid;
      }
      largest = low;
    }
    return {
      ...item,
      availableMinutes: largest,
      shortfallMinutes: Math.max(0, Math.ceil(item.duration) - largest),
      reason: item.requiresReview
        ? "The source program currently requires more than one visit."
        : item.type === "workout" && item.basis !== "model"
          ? `Needs ${Math.ceil(item.duration)} minutes including changing; the largest available window is ${largest} minutes after travel and meals (${Math.ceil(item.duration) - largest} minutes short). Review a workaround before changing training.`
          : `No continuous ${Math.ceil(item.duration)}-minute slot fits with travel, commitments and opening hours.`,
      quiet:
        item.type === "workout" &&
        item.day === "tuesday" &&
        item.basis === "model",
    };
  });
  for (const item of unplaced.filter((i) => !i.quiet))
    conflicts.push({
      id: `unplaced:${item.id}`,
      blockId: item.id,
      kind: "unplaced",
      message: `${item.title}: ${item.reason}`,
    });
  const expanded = primary.flatMap((b) =>
    b.type === "workout" && !b.complete && b.postChangeSeconds > 0
      ? [
          { ...b, end: b.end - b.postChangeSeconds / 60 },
          {
            id: `${b.id}:change`,
            title: "Cool down and change",
            type: "transition",
            start: b.end - b.postChangeSeconds / 60,
            end: b.end,
            location: "ratner",
            parentId: b.id,
          },
        ]
      : [b],
  );
  const busy = [...expanded, ...chain.legs];
  const free = freeIntervals(busy, bounds.wake, bounds.bed).map((i, n) => ({
    ...i,
    id: `free:${n}`,
    type: "free",
    title: "Free time",
  }));
  return {
    date,
    ...bounds,
    routine,
    primary,
    segments: ordered([...busy, ...free]),
    conflicts: [...new Map(conflicts.map((c) => [c.id, c])).values()],
    unplaced,
    notes,
    allDay: events.filter((e) => e.allDay || e.blocks === false),
    freeMinutes: [...free, ...primary.filter((b) => b.type === "home")].reduce(
      (n, i) => n + i.end - i.start,
      0,
    ),
    generatedAt: now,
  };
}
