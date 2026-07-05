'use strict';
// ─── Master timeline solver ───────────────────────────────────────────────────
// Composes the whole day from fixed anchors (calendar events + their travel, plus
// fixed tasks) and flexible blocks (morning routine, workout, flexible tasks,
// nighttime routine). Detects conflicts, relocates the workout when it clashes,
// and back-solves "leave by" / "wake by" for the next hard commitment.
//
// All times are minutes-from-midnight on the target local date. Returns a sorted
// list of segments plus conflict messages and the travel pairs still to prefetch.

function intervalsOverlap(a, b) { return a.start < b.end && b.start < a.end; }

// Travel minutes between two addresses, using cache; records misses for prefetch.
// Travel minutes between two addresses for a leg happening around `whenMin`
// (the leg's clock time) on weekday `dow`, traffic-adjusted.
function travelMin(originAddr, destAddr, pending, whenMin, dow) {
  if (!originAddr || !destAddr || normAddr(originAddr) === normAddr(destAddr)) return { min: 0, exact: true, none: true };
  // Video calls / links aren't places — no drive, and don't queue a geocode.
  if (isVirtualLoc(originAddr) || isVirtualLoc(destAddr)) return { min: 0, exact: true, none: true };
  const r = travelSecCached(originAddr, destAddr, DATA.settings.travelMode, whenMin, dow);
  if (r && r.exact) return { min: Math.max(1, Math.round(r.sec / 60)), exact: true, factor: r.factor, live: r.live };
  // geocoded but no real route yet → show the rough estimate, fetch the real one
  if (r && !r.exact) { if (pending) pending.push({ origin: originAddr, dest: destAddr, whenMin, dow }); return { min: Math.max(1, Math.round(r.sec / 60)), exact: false, approx: true }; }
  // not even geocoded yet → plain fallback buffer (no fabricated traffic) + queue a lookup
  if (pending) pending.push({ origin: originAddr, dest: destAddr, whenMin, dow });
  return { min: Math.max(1, Math.round(DATA.settings.defaultTravelMin || 15)), exact: false, fallback: true };
}
function travelSub(tv) {
  let s = tv.min + " min";
  if (tv.factor && tv.factor > 1.08) s += " · +" + Math.round((tv.factor - 1) * 100) + "% traffic";
  if (tv.live && tv.exact) s += " · live";
  else if (!tv.exact) s += tv.fallback ? " · est." : " · approx";
  return s;
}

// Find the earliest free gap of >= need minutes within [from,until], not colliding
// with `occupied` (sorted [{start,end}]), preferring a start at/after `pref`.
function findGap(occupied, from, until, need, pref) {
  const sorted = occupied.slice().sort((a, b) => a.start - b.start);
  // candidate windows = spaces between occupied intervals
  let windows = [];
  let cursor = from;
  for (const iv of sorted) {
    if (iv.start > cursor) windows.push({ start: cursor, end: Math.min(iv.start, until) });
    cursor = Math.max(cursor, iv.end);
    if (cursor >= until) break;
  }
  if (cursor < until) windows.push({ start: cursor, end: until });
  windows = windows.filter(w => w.end - w.start >= need);
  if (!windows.length) return null;
  // prefer a window containing `pref`
  if (pref != null) {
    for (const w of windows) if (pref >= w.start && pref + need <= w.end) return pref;
    for (const w of windows) if (w.start >= pref) return w.start; // next window after pref
  }
  return windows[0].start;
}

function computeTimeline(dateISO) {
  dateISO = dateISO || todayISO();
  const plan = dayPlan(dateISO);
  const S = DATA.settings;
  const home = S.homeAddress;
  const wakeMin = hmToMin(plan.wakeTime || S.wakeTime) ?? 420;
  let bedMin = hmToMin(plan.bedTime || S.bedTime) ?? 1380;
  if (bedMin <= wakeMin) bedMin += 1440; // bedtime after midnight
  const pending = [];
  const conflicts = [];
  const segments = [];
  const occupied = []; // fixed/placed intervals to avoid

  const dow = DOW[new Date(dateISO + "T00:00:00").getDay()];
  const dropList = plan.dropSteps || []; // morning steps amputated for this date
  const mDur = Math.round(routineBudgetSec(DATA.routineConfig, dow, dropList) / 60);
  const nDur = Math.round(routineBudgetSec(DATA.nightConfig, dow) / 60);

  function add(seg) { segments.push(seg); if (seg.blocks !== false) occupied.push({ start: seg.start, end: seg.end }); }

  // ── 1. Morning routine — anchored at wake ──
  const mSteps = routineSteps(DATA.routineConfig, dow).filter(s => dropList.indexOf(s.id) < 0).length;
  if (mDur > 0) add({ start: wakeMin, end: wakeMin + mDur, type: "routine", label: "Morning routine", sub: `${mDur} min · ${mSteps} steps` + (dropList.length ? ` · ${dropList.length} moved out` : ""), status: "ok", go: "Morning" });
  let morningEnd = wakeMin + mDur;

  // ── 2. Calendar events + fixed tasks → outings with travel ──
  // Events on a "flexible" calendar are work blocks (duration-based, gap-filled),
  // not fixed appointments — handled in §4 with the other flexible tasks.
  const events = cachedEventsFor(dateISO).filter(e => !e.allDay && !e.flex).map(e => ({ ...e, kind: "event" }));
  const flexEvents = cachedEventsFor(dateISO).filter(e => !e.allDay && e.flex);
  const allDayEvents = cachedEventsFor(dateISO).filter(e => e.allDay);
  const fixedTasks = (plan.tasks || []).filter(t => t.fixedStart != null && hmToMin(t.fixedStart) != null)
    .map(t => ({ id: t.id, kind: "task", title: t.name, location: t.location || "", startMin: hmToMin(t.fixedStart), endMin: hmToMin(t.fixedStart) + (t.durMin || 30) }));
  const anchored = events.concat(fixedTasks).sort((a, b) => a.startMin - b.startMin);

  // Place each commitment (travel legs are added later by the chain pass, so each
  // leg can use the right origin/destination and the traffic at its clock time).
  const GROUP_GAP = 90; // gap (min) above which you'd return home between stops
  anchored.forEach(ev => {
    const loc = ev.location || "";
    const status = ev.startMin < morningEnd ? "conflict" : "ok";
    if (status === "conflict") conflicts.push(`"${ev.title}" at ${fmtClock(ev.startMin)} starts before your morning routine finishes (${fmtClock(morningEnd)}).`);
    add({ start: ev.startMin, end: Math.max(ev.endMin, ev.startMin + 5), type: ev.kind, label: ev.title, sub: ev.allDay ? "all day" : fmtClock(ev.startMin) + "–" + fmtClock(ev.endMin), status, location: loc, source: ev.source });
  });

  // overlaps among fixed commitments
  for (let i = 0; i < anchored.length; i++)
    for (let j = i + 1; j < anchored.length; j++)
      if (intervalsOverlap({ start: anchored[i].startMin, end: anchored[i].endMin }, { start: anchored[j].startMin, end: anchored[j].endMin }))
        conflicts.push(`"${anchored[i].title}" and "${anchored[j].title}" overlap.`);

  // ── 3. Workout block (flexible, prefers its depart time) ──
  // Reserve the gap as travel + workout + travel (home round-trip estimate at the
  // preferred departure time); the actual travel legs/origins are set by the chain.
  const workMin = workoutSkippedFor(dateISO) ? 0 : workoutDurationMin(dateISO);
  if (workMin > 0) {
    const gym = S.gymAddress;
    const pref = workoutDepartMin(dateISO);
    const tTo = travelMin(home, gym, pending, pref, dow);
    const tBack = travelMin(gym, home, pending, pref + tTo.min + workMin, dow);
    const need = tTo.min + workMin + tBack.min;
    const place = findGap(occupied, Math.min(morningEnd, pref), bedMin - nDur, need, pref);
    if (place == null) {
      conflicts.push(`Workout (${need} min incl. travel) doesn't fit before bed — adjust the gym time or shorten the day.`);
    } else {
      const moved = Math.abs(place - pref) > 5;
      // the workout sits at the gym; the chain pass adds travel to/from it.
      add({ start: place + tTo.min, end: place + tTo.min + workMin, type: "workout", label: "Workout", sub: `${workMin} min · ${workoutBlockName(workoutBlockState().blockId)}` + (moved ? ` · moved from ${fmtClock(pref)}` : ""), status: moved ? "moved" : "ok", go: "Workout", location: gym });
      // Reserve the travel legs too — the chain pass only adds the actual travel
      // segments later (after flexible tasks are placed), so without this a
      // flexible task could be slotted into the drive-to/from-gym window.
      if (tTo.min > 0) occupied.push({ start: place, end: place + tTo.min });
      if (tBack.min > 0) occupied.push({ start: place + tTo.min + workMin, end: place + tTo.min + workMin + tBack.min });
      if (moved) conflicts.push(`Workout moved to ${fmtClock(place)} (your ${fmtClock(pref)} slot was taken).`);
    }
  }

  // Located stops placed so far (events, fixed tasks, workout), in day order —
  // the travel chain runs over these. Recomputed in §5b after flexible blocks
  // are placed, since located one-off tasks join the chain too.
  const locatedStops = () => segments
    .filter(s => s.location && !isVirtualLoc(s.location) && normAddr(s.location) !== normAddr(home) && (s.type === "event" || s.type === "task" || s.type === "workout"))
    .sort((a, b) => a.start - b.start);

  // Predict the chain's travel legs for a stop list. Each inbound leg carries
  // the context §5b needs for its status/conflict messages.
  function chainLegs(stops) {
    const legs = [];
    let prevLoc = home, prevEnd = wakeMin;
    stops.forEach(stop => {
      const gap = stop.start - prevEnd;
      let wentHome = false;
      // long gap since the last stop → you return home in between
      if (prevLoc && normAddr(prevLoc) !== normAddr(home) && gap > GROUP_GAP) {
        const tv = travelMin(prevLoc, home, pending, prevEnd, dow);
        if (tv.min > 0) legs.push({ start: prevEnd, end: prevEnd + tv.min, toHome: true, tv });
        prevLoc = home;
        wentHome = true;
      }
      const origin = (prevLoc && normAddr(prevLoc) !== normAddr(home)) ? prevLoc : home;
      const tv = travelMin(origin, stop.location, pending, stop.start, dow);
      if (tv.min > 0) legs.push({ start: stop.start - tv.min, end: stop.start, stop, tv, origin, wentHome, prevEnd, gap });
      prevLoc = stop.location; prevEnd = stop.end;
    });
    if (prevLoc && normAddr(prevLoc) !== normAddr(home)) {
      const tv = travelMin(prevLoc, home, pending, prevEnd, dow);
      if (tv.min > 0) legs.push({ start: prevEnd, end: prevEnd + tv.min, toHome: true, tv });
    }
    return legs;
  }

  // ── 3b. Hold the travel time around the fixed commitments ──
  // The real legs are only drawn in §5b, once every block is placed — reserving
  // their time now keeps the night routine and one-off tasks from being slotted
  // into, say, the drive home from an evening class.
  chainLegs(locatedStops()).forEach(l => occupied.push({ start: l.start, end: l.end }));

  // ── 4. Nighttime routine — at its usual start time, or before going out ──
  // The routine normally starts at its usual time (Settings → "Night routine
  // usually starts", default 8:00 PM) and slides later when that slot is taken.
  // If you're going out, it instead moves to finish before you leave. Placed
  // before the flexible tasks so they fill around it, not steal its slot.
  if (nDur > 0) {
    let nightOut = (plan.nightMode === "beforeOut" && hmToMin(plan.nightOutTime) != null) ? hmToMin(plan.nightOutTime) : null;
    if (nightOut != null && nightOut <= wakeMin) nightOut += 1440; // late-night out
    if (nightOut != null) {
      const nightStart = nightOut - nDur;
      const lastBusy = occupied.filter(o => o.end <= nightOut + 1).reduce((m, o) => Math.max(m, o.end), morningEnd);
      const status = nightStart < lastBusy - 1 ? "conflict" : "ok";
      if (status === "conflict") conflicts.push(`To finish the night routine before going out at ${fmtClock(nightOut)} you'd need to start by ${fmtClock(nightStart)}, but your day runs to ${fmtClock(lastBusy)}.`);
      add({ start: nightStart, end: nightOut, type: "routine", label: "Nighttime routine", sub: `${nDur} min · before you go out (${fmtClock(nightOut)})`, status, go: "Night" });
    } else {
      let pref = hmToMin(plan.nightTime || S.nightTime) ?? (bedMin - nDur);
      if (pref <= wakeMin) pref += 1440; // a past-midnight usual time rolls over like bedtime
      pref = Math.min(Math.max(pref, morningEnd), bedMin - nDur); // must still end by bed
      const place = findGap(occupied, morningEnd, bedMin, nDur, pref);
      if (place == null) {
        conflicts.push(`No room left for the ${nDur}-min night routine before your ${fmtClock(bedMin)} bedtime.`);
        add({ start: bedMin - nDur, end: bedMin, type: "routine", label: "Nighttime routine", sub: `${nDur} min · usually ${fmtClock(pref)}`, status: "conflict", go: "Night" });
      } else {
        const moved = Math.abs(place - pref) > 5;
        add({ start: place, end: place + nDur, type: "routine", label: "Nighttime routine", sub: `${nDur} min` + (moved ? ` · moved from ${fmtClock(pref)}` : ""), status: moved ? "moved" : "ok", go: "Night" });
      }
    }
  }

  // ── 5. Flexible tasks (no fixed time) → fill gaps ──
  (plan.tasks || []).filter(t => t.fixedStart == null).forEach(t => {
    const need = (t.durMin || 30);
    const place = findGap(occupied, morningEnd, bedMin, need, null);
    if (place == null) { conflicts.push(`Task "${t.name}" (${need} min) doesn't fit today.`); return; }
    add({ start: place, end: place + need, type: "task", label: t.name, sub: `${need} min`, status: "ok", taskId: t.id });
  });

  // Flexible work blocks from the briefing calendar → slot into open time,
  // preferring the time Claude scheduled them but moving them if it's taken.
  flexEvents.forEach(ev => {
    const need = Math.max(10, (ev.endMin - ev.startMin) || 30);
    const place = findGap(occupied, morningEnd, bedMin, need, ev.startMin);
    if (place == null) { conflicts.push(`Work block "${ev.title}" (${need} min) doesn't fit today.`); return; }
    const moved = Math.abs(place - ev.startMin) > 5;
    add({ start: place, end: place + need, type: "task", label: ev.title, sub: `${need} min · work block` + (moved ? ` · from ${fmtClock(ev.startMin)}` : ""), status: "ok", flex: true });
  });

  // ── 5b. Travel chain ──
  // For every located block, the inbound leg starts from where you'll be directly
  // before it (the previous located block) and the outbound leg goes to where you
  // go directly after — defaulting to home when there's nothing adjacent. Each leg
  // is timed for its own clock time so traffic is estimated for that moment.
  chainLegs(locatedStops()).forEach(l => {
    if (l.toHome) {
      add({ start: l.start, end: l.end, type: "travel", label: "Travel home", sub: travelSub(l.tv), status: "ok", location: home });
      return;
    }
    const { stop, tv, origin, wentHome, prevEnd, gap } = l;
    let status = "ok";
    if (!wentHome && normAddr(origin) !== normAddr(home) && l.start < prevEnd - 1) {
      // a fixed commitment you genuinely can't reach in time is a conflict;
      // the flexible workout can just start later, so flag it softly as "tight".
      if (stop.type === "workout") status = "tight";
      else { status = "conflict"; conflicts.push(`Only ${Math.max(0, gap)} min to get from your previous stop to "${stop.label}", but the drive is ~${tv.min} min${tv.factor > 1.08 ? " in traffic" : ""}.`); }
    }
    add({ start: l.start, end: stop.start, type: "travel", label: "Travel → " + stop.label, sub: travelSub(tv), status, location: stop.location });
  });

  // ── 6. Fill the gaps with free time ──
  const sorted = segments.slice().sort((a, b) => a.start - b.start);
  let cursor = wakeMin;
  const free = [];
  sorted.forEach(s => { if (s.start > cursor + 4) free.push({ start: cursor, end: s.start, type: "free", label: "Free", sub: (s.start - cursor) + " min open", status: "free" }); cursor = Math.max(cursor, s.end); });
  if (bedMin > cursor + 4) free.push({ start: cursor, end: bedMin, type: "free", label: "Free", sub: (bedMin - cursor) + " min open", status: "free" });
  const all = sorted.concat(free).sort((a, b) => a.start - b.start);

  // ── 7. Back-solve next departure + wake-by for the first hard commitment ──
  const nowMin = (dateISO === todayISO()) ? (new Date().getHours() * 60 + new Date().getMinutes()) : -1;
  const departures = all.filter(s => s.type === "travel" && s.label.indexOf("home") < 0);
  let leaveBy = null;
  for (const d of departures) { if (nowMin < 0 || d.start >= nowMin) { leaveBy = { min: d.start, label: d.label.replace("Travel → ", "") }; break; } }
  // Wake-by = the latest you can wake and still finish the morning routine (+ any
  // travel) before your EARLIEST commitment of the day — located or not.
  let wakeBy = null, firstCommit = null;
  const earliest = anchored.length ? anchored[0] : null;
  if (earliest) {
    const tvMin = (earliest.location && earliest.location.trim() && home) ? travelMin(home, earliest.location, pending, earliest.startMin, dow).min : 0;
    wakeBy = earliest.startMin - tvMin - mDur;
    firstCommit = { title: earliest.title, startMin: earliest.startMin, location: earliest.location || "", travelMin: tvMin };
  }
  // Does the morning routine genuinely clash with that first commitment?
  const morningClash = !!(firstCommit && wakeBy != null && wakeBy < wakeMin);

  // Stamp the target date on each travel-prefetch request so predictive traffic
  // (TomTom departAt) is fetched for the day the leg actually happens — important
  // for tomorrow's night-before look-ahead, not just today.
  pending.forEach(p => { if (p && !p.dateISO) p.dateISO = dateISO; });

  const busyMin = all.filter(s => s.type !== "free").reduce((m, s) => m + (s.end - s.start), 0);
  return {
    date: dateISO, wakeMin, bedMin, mDur, nDur, workMin, dropList,
    segments: all, conflicts, allDayEvents,
    leaveBy, wakeBy, firstCommit, morningClash, busyMin, pending,
  };
}

function todayRoutineCount(cfg, dow) { return routineSteps(cfg, dow).length; }
