import {
  KEY,
  BACKUP,
  MIGRATION,
  defaults,
  loadState,
  saveState,
  validate,
  plannerEntities,
  adoptPlannerEntities,
} from "./state.js";
import {
  dateISO,
  addDays,
  monday,
  weekday,
  atMinute,
  clockMinutes,
  formatDate,
  formatTime,
  sleepBounds,
} from "./dates.js";
import {
  morningSteps,
  groomingSunday,
  startRun,
  finishStep,
  pauseRun,
  undoStep,
  elapsedStep,
} from "./routines.js";
import { scheduleDay } from "./timeline.js";
import {
  fetchCalendar,
  eventsForDate,
  mechanicsOverrides,
} from "./calendar.js";
import { PLACES, resolvePlace, routeKey, travelBetween } from "./travel.js";
import { facilityHours } from "./facilities.js";
import { validateFeed, workoutForDate, FEED_KEY } from "./workout.js";
import { DriveSync, canonical } from "./cloud-sync.js";
import { GoogleAuth, DRIVE_SCOPE, CALENDAR_SCOPE } from "./google-auth.js";

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safeUrl = (value) => {
  try {
    const u = new URL(value, location.href);
    return ["https:", "http:"].includes(u.protocol) ? u.href : "#";
  } catch {
    return "#";
  }
};
const minutesLabel = (n) =>
  n >= 60
    ? `${Math.floor(n / 60)}h ${Math.round(n % 60)}m`
    : `${Math.round(n)} min`;
const timeInput = (n) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const clock = (seconds) =>
  `${seconds < 0 ? "+" : ""}${Math.floor(Math.abs(seconds) / 60)}:${String(Math.floor(Math.abs(seconds) % 60)).padStart(2, "0")}`;
let state,
  view = "today",
  selectedDate = dateISO(),
  feed = null,
  auth,
  cloud,
  calendarBusy = false,
  toastTimer,
  lastFocus,
  applyingCloud = false,
  updateRegistration,
  acceptedUpdate = false;
let placements = {},
  cache = new Map(),
  feedError = "",
  storageError = "",
  lastCalendarError = "",
  undo = null;
const isEditing = () =>
  $("dialog").open ||
  document.activeElement?.matches("input,textarea,select") ||
  !!document.querySelector("form[data-dirty]");
try {
  const loaded = loadState(localStorage);
  state = loaded.state;
  if (loaded.message) setTimeout(() => toast(loaded.message), 300);
} catch (error) {
  storageError = error.message;
}
try {
  const raw = localStorage.getItem(FEED_KEY);
  if (raw) feed = validateFeed(JSON.parse(raw));
} catch (e) {
  feedError = e.message;
}
try {
  placements = JSON.parse(localStorage.getItem("planner_placements_v2")) || {};
} catch {
  /* This is a disposable view cache. */
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 6500);
}
function commit(fn, message, options = {}) {
  if (!state) throw Error("Restore a valid backup before making changes.");
  const next = structuredClone(state);
  fn(next);
  state = saveState(localStorage, next, state.version);
  cache.clear();
  if (!options.cacheOnly && !applyingCloud) cloud?.capture();
  if (message) toast(message);
  if (options.render !== false) render();
}
function resultFor(date) {
  const stamp = `${state.version}:${feed?.sourceRevision}:${feed?.generatedAt}:${(state.runs[date] && !state.runs[date].finishedAt) || Object.values(state.activities).some((a) => a.status === "active") ? Math.floor(Date.now() / 60000) : ""}`;
  if (cache.get(date)?.stamp === stamp) return cache.get(date).value;
  const result = scheduleDay({
    date,
    settings: state.settings,
    events: eventsForDate(
      state.calCache,
      date,
      state.settings.locationOverrides,
    ),
    commitments: state.commitments,
    workout: workoutForDate(feed, date),
    run: state.runs[date],
    activities: state.activities,
    previous: placements[date] || [],
  });
  cache.set(date, { stamp, value: result });
  if (date === dateISO()) {
    placements[date] = result.primary.filter((b) =>
      ["meal", "workout", "task"].includes(b.type),
    );
    placements = Object.fromEntries(
      Object.entries(placements).filter(([d]) => d >= addDays(dateISO(), -7)),
    );
    try {
      localStorage.setItem("planner_placements_v2", JSON.stringify(placements));
    } catch {
      /* Scheduling remains usable if view-cache storage is full. */
    }
  }
  return result;
}
function calendarStatus() {
  const selected = state.settings.googleCalendarIds
    .map((id) => state.calCache[id])
    .filter(Boolean);
  if (!selected.length)
    return auth?.getToken()
      ? "Calendar has not loaded yet."
      : "Connect Google to include your classes.";
  const minutes = Math.max(
    0,
    Math.floor(
      (Date.now() - Math.min(...selected.map((c) => c.updatedAt || 0))) / 60000,
    ),
  );
  return `${calendarBusy ? "Refreshing · " : ""}Calendar updated ${minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)}h ago`}${auth?.getToken() ? "" : " · reconnect to refresh"}`;
}
function dateControls() {
  return `<div class="date-controls"><button class="quiet" data-action="previous-day" aria-label="Previous day">←</button><input aria-label="Selected date" id="selected-date" type="date" value="${selectedDate}"><button class="quiet" data-action="next-day" aria-label="Next day">→</button><button class="quiet" data-action="today">Today</button></div>`;
}
function heading(eyebrow, title, subtitle = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${dateControls()}</div>`;
}
function blockDetails(b) {
  const location = b.location
    ? resolvePlace(b.location, state.settings.places)
    : null;
  let detail = `<p>${Math.round(b.end - b.start)} minutes${location ? ` · ${esc(location.display || location.label)}` : ""}${b.earlierPlan ? " · earlier planned activity, not marked complete" : ""}</p>`;
  if (b.route)
    detail += `<p>${esc(b.route.basis)} · includes leaving the building and entering the next one. ${b.route.unknown ? "Set the location or a personal walking time in Settings to improve this allowance." : ""}</p><a href="${safeUrl(`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(b.route.origin.address || b.route.origin.label)}&destination=${encodeURIComponent(b.route.destination.address || b.route.destination.label)}&travelmode=walking`)}" target="_blank" rel="noopener">Walking directions ↗</a>`;
  if (b.hours)
    detail += `<p>${esc(b.hours.note || "Facility hours applied")}${b.hours.source ? ` · <a href="${safeUrl(b.hours.source)}" target="_blank" rel="noopener">Source ↗</a>` : ""}</p>`;
  if (b.type === "workout")
    detail += `<p>${b.basis === "model" ? "Component estimate from your current Oly prescription." : `${b.basis === "reported" ? "Your reported matching session" : `${b.sampleCount} matching measured sessions`}.`} Warm-ups and rests included. Walking is separate. ${b.postChangeSeconds ? "Changing time is shown separately." : "This measurement already includes cooling down and changing."} ${b.projected ? "Future week uses the current dose until you advance the program in Oly." : ""}</p><button data-view="workout">Open workout</button>`;
  if (b.type === "event")
    detail += `<div class="actions"><a class="button quiet" href="${safeUrl(b.htmlLink || "https://calendar.google.com")}" target="_blank" rel="noopener">Edit in Google Calendar ↗</a><button data-action="event-location" data-id="${esc(b.id)}">Set location</button></div>`;
  if (b.type === "task")
    detail += `<div class="actions"><button data-action="edit" data-id="${esc(b.id)}">Edit</button><button class="danger" data-action="delete" data-id="${esc(b.id)}">Delete</button></div>`;
  if (
    ["meal", "task"].includes(b.type) &&
    !b.complete &&
    selectedDate === dateISO()
  )
    detail += `<div class="actions">${!b.active ? `<button data-action="activity-start" data-id="${esc(b.id)}">Start now</button>` : ""}<button data-action="activity-done" data-id="${esc(b.id)}">Mark complete</button>${!b.fixed || b.earlierPlan ? `<button data-action="activity-replan" data-id="${esc(b.id)}">Replan from now</button>` : ""}</div>`;
  return detail;
}
function blockView(b, result) {
  const conflict = result.conflicts.some((c) => c.blockId === b.id);
  const sub = b.complete
    ? "Completed"
    : b.active
      ? "In progress"
      : b.type === "travel"
        ? `${b.route.minutes} min · ${b.route.basis}`
        : b.type === "event"
          ? b.location || "Location needed"
          : b.type === "meal"
            ? resolvePlace(b.location).label
            : b.type === "workout"
              ? `${b.basis === "model" ? "Estimated" : "Calibrated"} · ${Math.ceil(b.end - b.start)} min`
              : b.type === "free"
                ? `${Math.round(b.end - b.start)} minutes open`
                : `${Math.round(b.end - b.start)} min`;
  return `<div class="timeline-row ${b.type}"><details class="block ${b.type} ${conflict ? "conflict" : ""}" data-block="${esc(b.id)}"><summary><div class="block-time">${formatTime(b.start)}<span>${formatTime(b.end)}</span></div><div class="block-title">${esc(b.title)}<small>${esc(sub)}</small></div></summary><div class="block-body">${blockDetails(b)}</div></details></div>`;
}
function todayView() {
  const r = resultFor(selectedDate),
    now = Date.now() / 60000,
    isToday = selectedDate === dateISO();
  const current = isToday
    ? r.segments.find((b) => b.start <= now && b.end > now && b.type !== "free")
    : null;
  const next = r.segments.find(
    (b) => b.type !== "free" && (!isToday || b.start > now),
  );
  const departure = r.segments.find(
    (b) => b.type === "travel" && (!isToday || b.end > now),
  );
  const hero = current || next;
  const morningStart = r.routine[0].start,
    morningEnd = r.routine.at(-1).end;
  const morning = {
    id: "morning-group",
    title: "Morning routine",
    start: morningStart,
    end: morningEnd,
    type: "routine",
    location: "grossman",
  };
  const sections = [
    ...r.segments.filter((b) => !b.id.startsWith("morning:")),
    morning,
  ].sort((a, b) => a.start - b.start);
  const workout = workoutForDate(feed, selectedDate);
  return (
    heading(
      "A LITTLE STRUCTURE. ROOM TO LIVE.",
      isToday ? "Make room for today." : formatDate(selectedDate),
      `${formatDate(selectedDate)} · All times Chicago`,
    ) +
    `<section class="hero"><div><p class="eyebrow">${current ? "ON YOUR PLAN NOW" : next ? "UP NEXT" : "DAY COMPLETE"}</p><h2>${hero ? esc(hero.title) : "The rest is yours."}</h2><p>${hero ? `${formatTime(hero.start)}–${formatTime(hero.end)}${hero.location ? ` · ${esc(resolvePlace(hero.location).label)}` : ""}` : `Your next wake-up is ${formatTime(r.nextWake)}.`}</p></div><div class="hero-side"><small>${departure ? "LEAVE BY" : "SLEEP AT"}</small><div class="hero-time">${formatTime(departure?.start ?? r.bed)}</div><small>${departure ? esc(departure.route.destination.label) : "Seven hours protected"}</small>${isToday ? `<small id="departure-countdown" data-at="${departure?.start ?? r.bed}"></small>` : ""}</div></section>` +
    `<div class="metrics"><div class="metric"><small>Free time</small><strong>${minutesLabel(r.freeMinutes)}</strong></div><div class="metric"><small>Morning</small><strong>${Math.round(morningEnd - morningStart)} min</strong></div><div class="metric"><small>Sleep window</small><strong>7 hours</strong></div></div>` +
    `<div class="day-grid"><div><div class="section-heading"><h2>The shape of your day</h2><small>${r.primary.filter((b) => b.type === "event").length} calendar commitments</small></div>${r.conflicts.length ? `<div class="notice alert"><strong>Needs a decision</strong><ul>${r.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join("")}</ul></div>` : ""}${r.allDay.length ? `<div class="notice">${r.allDay.map((e) => esc(e.title) + (e.allDay ? " · all day" : " · does not block time")).join("<br>")}</div>` : ""}<div class="timeline">${sections.map((b) => (b.id === "morning-group" ? `<div class="timeline-row routine"><details class="block routine" data-block="morning-group"><summary><div class="block-time">${formatTime(b.start)}<span>${formatTime(b.end)}</span></div><div class="block-title">Morning routine<small>${groomingSunday(selectedDate) ? "Grooming Sunday + vacuum" : weekday(selectedDate) === 0 ? "Sunday + vacuum" : [1, 4].includes(weekday(selectedDate)) ? "Hair and shaving morning" : "Everyday morning"}</small></div></summary><div class="block-body"><ol>${r.routine.map((s) => `<li>${formatTime(s.start)} · ${esc(s.title)} · ${Math.round(s.end - s.start)} min</li>`).join("")}</ol><button data-view="morning">Open morning routine</button></div></details></div>` : blockView(b, r))).join("")}</div>${r.unplaced.length ? `<section class="card"><h2>Still to place</h2>${r.unplaced.map((b) => `<p><strong>${esc(b.title)}</strong> · ${Math.ceil(b.duration)} min<br><small>${esc(b.quiet ? "Provisional timing; retained here while the session is calibrated." : b.reason)}</small></p>`).join("")}</section>` : ""}</div><aside class="day-aside"><section class="card"><p class="eyebrow">YOUR DAILY ANCHORS</p><div class="sleep-row"><span>Wake up</span><strong>${formatTime(r.wake)}</strong></div><div class="sleep-row"><span>Sleep</span><strong>${formatTime(r.bed)}</strong></div><p class="fine-print" style="margin-top:14px">Same wake time every day. Seven elapsed hours, including clock-change nights.</p></section><section class="card"><p class="eyebrow">CONNECTED TO YOUR LIFE</p><p>${esc(calendarStatus())}</p>${lastCalendarError ? `<p>${esc(lastCalendarError)}</p>` : ""}${!auth?.getToken() ? `<button data-action="connect">Connect Google</button>` : ""}<hr><p>${feed ? (workout ? `${esc(workout.label)} · ${minutesLabel(workout.forecastSeconds / 60)} ${workout.basis === "model" ? "estimated" : "calibrated"}` : "No workout scheduled today.") : "Open Workout to load your current Oly program."}</p>${feedError ? `<p>${esc(feedError)}</p>` : ""}<button class="quiet" data-view="workout">Open Oly →</button></section><section class="card"><p class="eyebrow">ROOM FOR THE REAL JOURNEY</p><p>Walking includes building entry and exit. Meals include the line and cleanup.</p><p class="fine-print">Bathroom cleaning: 7–8 AM and 2:15–2:30 PM. ${workout ? esc(facilityHours("ratner", selectedDate, state.settings.hours).note) : ""}</p><button class="quiet" data-view="settings">Adjust your assumptions →</button></section></aside></div>`
  );
}
function weekView() {
  const from = monday(selectedDate);
  return (
    heading(
      "SEE THE WEEK AHEAD",
      "A rhythm you can keep.",
      "Four training days. Your classes stay fixed. Everything else gets room to fit.",
    ) +
    `<div class="week-grid">${Array.from({ length: 7 }, (_, i) =>
      addDays(from, i),
    )
      .map((date) => {
        const r = resultFor(date),
          w = workoutForDate(feed, date);
        return `<section class="card week-card"><p class="eyebrow">${formatDate(date, { weekday: undefined })}</p><h2>${formatDate(date, { month: undefined, day: undefined })}<span class="pill">${minutesLabel(r.freeMinutes)} free</span></h2><p class="fine-print">Morning finishes ${formatTime(r.routine.at(-1).end)}</p>${r.primary
          .filter((b) => ["event", "meal", "workout", "task"].includes(b.type))
          .map(
            (b) =>
              `<div class="week-item">${formatTime(b.start)} · ${esc(b.title)}<small>${esc(b.location ? resolvePlace(b.location).label : "Location needed")}</small></div>`,
          )
          .join(
            "",
          )}${r.unplaced.map((b) => `<div class="week-item">${esc(b.title)}<small>Still to place${b.quiet ? " · provisional" : ""}</small></div>`).join("")}${r.conflicts.length ? `<p class="fine-print">${r.conflicts.length} scheduling issue${r.conflicts.length > 1 ? "s" : ""}</p>` : ""}${w?.projected ? `<p class="fine-print">Projected using the current Oly dose.</p>` : ""}<button data-action="open-day" data-date="${date}">See day →</button></section>`;
      })
      .join("")}</div>`
  );
}
function morningView() {
  const run = state.runs[selectedDate],
    steps =
      run?.steps || morningSteps(selectedDate, state.settings.routineDurations),
    total = steps.reduce((n, s) => n + s.seconds, 0),
    step = run?.steps[run.index];
  const runner =
    run && !run.finishedAt
      ? `<section class="card runner"><p class="eyebrow">STEP ${run.index + 1} OF ${steps.length}</p><h2>${esc(step.title)}</h2><div class="runner-clock" id="morning-clock" role="timer">${clock(step.seconds - elapsedStep(run))}</div><p id="morning-status">${run.pausedAt !== null ? "Paused · the day’s clock continues" : "Finish the step, then continue."}</p>${run.masqueStartedAt ? `<p id="masque-clock">Masque is processing during the following steps.</p>` : ""}<div class="actions"><button class="primary" data-action="step-done">Done, next step</button><button class="quiet" data-action="step-pause">${run.pausedAt !== null ? "Resume" : "Pause"}</button><button class="quiet" data-action="step-skip">Skip step</button>${run.index ? `<button class="quiet" data-action="step-undo">Undo last step</button>` : ""}</div></section>`
      : run?.finishedAt
        ? `<section class="card"><h2>Morning complete.</h2><p>${minutesLabel((run.finishedAt - run.startedAt) / 60000)} elapsed · finished ${formatTime(run.finishedAt / 60000)}.</p><button data-action="step-undo">Correct the last step</button></section>`
        : `<section class="card"><h2>${Math.round(total / 60)} minutes, with breathing room.</h2><p>${[1, 4].includes(weekday(selectedDate)) ? "Hair, two-pass shaving, and the full morning sequence." : groomingSunday(selectedDate) ? "Body shaving, eyebrows, nails and the weekly vacuum." : weekday(selectedDate) === 0 ? "Your everyday routine, then the weekly vacuum." : "Your everyday shower and morning routine."}</p><button class="primary" data-action="routine-start" ${selectedDate !== dateISO() ? "disabled" : ""}>Start morning routine</button>${selectedDate !== dateISO() ? `<p class="fine-print">Switch to today to start the live routine.</p>` : ""}</section>`;
  return (
    heading(
      "ONE STEP AT A TIME",
      "Start with a clear head.",
      `${formatDate(selectedDate)} · Bathroom closes at 7 AM`,
    ) +
    runner +
    `<section class="card"><div class="section-heading"><h2>The whole routine</h2><small>${steps.length} steps</small></div><ol class="step-list">${steps.map((s, i) => `<li class="${run?.completed[i] ? "completed" : i === run?.index && !run.finishedAt ? "current" : ""}"><span class="step-number">${run?.completed[i] ? (run.completed[i].skipped ? "–" : "✓") : i + 1}</span><span class="step-name">${esc(s.title)}</span><span class="step-duration">${minutesLabel(s.seconds / 60)}</span></li>`).join("")}</ol><p class="fine-print" style="margin-top:16px">Setup and transitions are explicit. Masque processing overlaps other steps. A timer reaching zero never completes a step automatically.</p></section>`
  );
}
const placeOptions = (selected = "") =>
  Object.entries({ ...PLACES, ...state.settings.places })
    .map(
      ([id, p]) =>
        `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(p.label)}</option>`,
    )
    .join("");
function settingsView() {
  const s = state.settings;
  return `<div class="page-heading"><div><p class="eyebrow">MAKE THE ASSUMPTIONS YOURS</p><h1>A plan grounded in real life.</h1><p>Changes apply across your schedule. Your training program stays in Oly.</p></div></div><div class="settings-grid">
  <section class="card"><h2>Google connection</h2><p class="fine-print" id="settings-sync-status">${esc(cloud?.status || "Saved on this device")}</p><form data-form="google"><label>Google OAuth client ID<input name="clientId" value="${esc(s.googleClientId)}" autocomplete="off" placeholder="…apps.googleusercontent.com"></label><label>Read-only calendar IDs, one per line<textarea name="calendars">${esc(s.googleCalendarIds.join("\n"))}</textarea></label><p class="fine-print">Use “primary” for your main calendar. The same client ID is used by the embedded and standalone Oly apps. Planner commitments stay in Planner.</p><p class="form-error" role="alert"></p><button type="submit">Save connection settings</button></form><div class="actions" style="margin-top:12px"><button class="primary" data-action="connect">${auth?.getToken() ? "Reconnect Google" : "Connect Google"}</button><button class="quiet" data-action="disconnect">Disconnect</button><button data-action="conflicts" ${cloud?.conflicts.length ? "" : "hidden"}>Resolve sync conflicts</button></div></section>
  <section class="card"><h2>Sleep and meals</h2><form data-form="preferences"><label>Everyday wake-up<input name="wake" type="time" value="${esc(s.wakeTime)}" required></label><p class="fine-print">Bedtime is seven elapsed hours before the next wake-up. There are no automatic nighttime, reading or study blocks.</p><label><input name="homeBreaks" type="checkbox" ${s.returnHomeDuringBreaks === true ? "checked" : ""}>Prefer free breaks at the dorm when both walks leave at least 30 minutes there</label><div class="input-grid">${Object.entries(
    s.mealMinutes,
  )
    .map(
      ([id, min]) =>
        `<label>${id[0].toUpperCase() + id.slice(1)} · minutes<input name="${id}" type="number" min="5" max="180" value="${min}" required></label>`,
    )
    .join(
      "",
    )}</div><p class="form-error" role="alert"></p><div class="form-actions"><button type="submit">Save daily timing</button></div></form></section>
  <section class="card span-two"><h2>Morning timing</h2><p class="fine-print">Edit an allowance after measuring it. The cold shower stays three minutes. Changes affect future runs; an active run keeps its starting steps.</p><form data-form="routine-timing"><div class="table-scroll"><table><thead><tr><th>Step</th><th>Minutes</th></tr></thead><tbody>${[...new Map([...morningSteps("2026-09-21", s.routineDurations), ...morningSteps("2026-09-20", s.routineDurations)].map((step) => [step.id, step])).values()].map((step) => `<tr><td><label for="duration-${step.id}">${esc(step.title)}</label></td><td><input id="duration-${step.id}" name="${step.id}" type="number" min="${step.id === "cold" ? 3 : 0.5}" max="60" step="0.5" value="${step.seconds / 60}" ${step.id === "cold" ? "readonly" : ""} required></td></tr>`).join("")}</tbody></table></div><p class="form-error" role="alert"></p><div class="form-actions"><button type="submit">Save morning allowances</button></div></form></section>
  <section class="card"><h2>Walking and transitions</h2><p class="fine-print">Times are door to door: walking plus exit, entry, stairs and finding the room. Personal overrides take precedence over campus estimates.</p><form data-form="route"><div class="input-grid"><label>From<select name="from">${placeOptions("grossman")}</select></label><label>To<select name="to">${placeOptions("ratner")}</select></label></div><label>Door-to-door minutes<input name="minutes" type="number" min="1" max="240" value="20" required></label><p class="form-error" role="alert"></p><button type="submit">Save walking time</button><button type="button" data-action="route-fetch">Calculate pedestrian route</button></form><form data-form="routing-key" style="margin-top:16px"><label>Optional TomTom API key<input name="key" type="password" value="${esc(s.tomtomKey || "")}" autocomplete="off"></label><button type="submit" class="quiet">Save routing key on this device</button></form>${Object.entries(
    s.routes,
  )
    .map(
      ([key, value]) =>
        `<p class="fine-print">${key
          .split("|")
          .map((id) => esc(resolvePlace(id, s.places).label))
          .join(
            " ↔ ",
          )} · ${value.minutes} min · ${esc(value.basis)} <button class="quiet" data-action="route-delete" data-id="${esc(key)}">Remove</button></p>`,
    )
    .join(
      "",
    )}<details><summary>Add another building</summary><form data-form="place"><label>Building name<input name="label" required></label><label>Address<input name="address" required></label><div class="input-grid"><label>Latitude<input name="lat" type="number" step="any" min="-90" max="90" required></label><label>Longitude<input name="lon" type="number" step="any" min="-180" max="180" required></label></div><p class="form-error" role="alert"></p><div class="form-actions"><button type="submit">Save building</button></div></form></details></section>
  <section class="card"><h2>Facility hours and exceptions</h2><p class="fine-print">Regular dining, summer service and orientation exceptions are included. Ratner’s post-September 27 hours use a conservative fallback until confirmed. Enter a dated override after checking the source.</p><form data-form="hours"><label>Facility<select name="place">${["ratner", "cathey", "woodlawn", "bartlett", "baker"].map((id) => `<option value="${id}">${PLACES[id].label}</option>`).join("")}</select></label><div class="input-grid"><label>From date<input name="from" type="date" value="${selectedDate}" required></label><label>Through date<input name="until" type="date" value="${selectedDate}" required></label></div><label>Opening intervals<input name="intervals" placeholder="07:00-21:00 or 07:00-10:00,11:00-14:30"><small>Leave blank for closed. Times are Chicago local time.</small></label><label>Source or note<input name="source" placeholder="Confirmed facility hours"></label><p class="form-error" role="alert"></p><button type="submit">Save dated hours</button></form>${s.hours.map((h, i) => `<p class="fine-print">${esc(resolvePlace(h.place).label)} · ${h.from}–${h.until} · ${h.intervals.length ? h.intervals.map(([a, b]) => `${timeInput(a)}–${timeInput(b)}`).join(", ") : "closed"} <button class="quiet" data-action="hours-delete" data-id="${i}">Remove</button></p>`).join("")}<div class="actions"><a href="https://athletics.uchicago.edu/sports/2023/6/12/facilities.aspx" target="_blank" rel="noopener">Ratner hours ↗</a><a href="https://dining.uchicago.edu/" target="_blank" rel="noopener">Dining hours ↗</a></div></section>
  <section class="card span-two"><h2>Your data stays yours</h2><p class="fine-print">Device backups include routine history, commitments and settings. Old morning and nighttime history remains preserved; obsolete routines are no longer scheduled. Oly maintains its own journal and private Drive revisions.</p><div class="actions"><button data-action="export">Export Planner backup</button><label class="file-button">Restore backup<input id="import-backup" type="file" accept="application/json,.json"></label>${localStorage.getItem(MIGRATION) ? `<button data-action="export-legacy">Export pre-rebuild backup</button>` : ""}<button data-action="undo" ${undo ? "" : "disabled"}>Undo last deletion</button><button data-action="check-update">Check for app update</button></div></section></div>`;
}
function render() {
  if (!state) {
    $("page-today").innerHTML =
      `<section class="card"><h1>Your saved data is intact.</h1><p>${esc(storageError)}</p><label class="file-button">Restore a valid backup<input id="import-backup" type="file" accept="application/json,.json"></label></section>`;
    return;
  }
  document.querySelectorAll("[data-page]").forEach((element) => {
    element.hidden = element.dataset.page !== view;
  });
  document
    .querySelectorAll("nav [data-view]")
    .forEach((button) =>
      button.setAttribute(
        "aria-current",
        button.dataset.view === view ? "page" : "false",
      ),
    );
  if (
    view === "settings" &&
    $("page-settings").querySelector("form[data-dirty]")
  ) {
    updateStatus();
    return;
  }
  const root = $(`page-${view}`),
    open = [...root.querySelectorAll("details[open][data-block]")].map(
      (d) => d.dataset.block,
    );
  const focused = document.activeElement,
    scroll = window.scrollY;
  let focusSelector = null;
  if (root.contains(focused)) {
    if (focused.id) focusSelector = `#${CSS.escape(focused.id)}`;
    else if (focused.dataset.action)
      focusSelector = `[data-action="${CSS.escape(focused.dataset.action)}"]${focused.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : ""}`;
    else if (focused.matches("summary") && focused.parentElement.dataset.block)
      focusSelector = `[data-block="${CSS.escape(focused.parentElement.dataset.block)}"] > summary`;
  }
  if (view !== "workout") {
    root.innerHTML = {
      today: todayView,
      week: weekView,
      morning: morningView,
      settings: settingsView,
    }[view]();
    root.querySelectorAll("details[data-block]").forEach((d) => {
      if (open.includes(d.dataset.block)) d.open = true;
    });
  } else {
    const workout = workoutForDate(feed, selectedDate);
    $("workout-freshness").textContent = feed
      ? `Oly week ${feed.program.week} · entry ${feed.program.entry} · ${workout?.projected ? "future dose projected" : "current journal"}`
      : "Opening the current Oly app. Its scheduling feed will appear here.";
    $("workout-summary").innerHTML = workout
      ? `<div class="card">${esc(workout.label)} · ${minutesLabel(workout.forecastSeconds / 60)} ${workout.basis === "model" ? "component estimate" : "calibrated forecast"} · guided allowance ${minutesLabel(workout.guideSeconds / 60)}. Changing and walking are handled by Planner.</div>`
      : "";
  }
  $("places").innerHTML = Object.entries({
    ...PLACES,
    ...state.settings.places,
  })
    .map(
      ([id, p]) => `<option value="${esc(p.label)}">${esc(p.address)}</option>`,
    )
    .join("");
  if (focusSelector)
    root.querySelector(focusSelector)?.focus({ preventScroll: true });
  window.scrollTo({ top: scroll });
  updateStatus();
  tick();
}
const pageScroll = {};
function navigate(next, date = selectedDate) {
  pageScroll[view] = window.scrollY;
  view = next;
  selectedDate = date;
  render();
  window.scrollTo({ top: pageScroll[next] || 0 });
  $("main").focus({ preventScroll: true });
}
function modal(title, content) {
  lastFocus = document.activeElement;
  $("dialog").innerHTML =
    `<div class="dialog-heading"><h2 id="dialog-title">${esc(title)}</h2><button class="quiet" data-action="close" aria-label="Close dialog">×</button></div>${content}`;
  $("dialog").showModal();
}
function closeModal() {
  $("dialog").close();
  if (lastFocus?.isConnected) lastFocus.focus();
}
function commitmentForm(id) {
  const c = state.commitments.find((item) => item.id === id) || {
    date: selectedDate,
    title: "",
    duration: 30,
    location: "",
    fixedStart: null,
    earliest: 540,
    latest: 1260,
  };
  modal(
    id ? "Edit commitment" : "Add a commitment",
    `<form data-form="commitment" data-id="${esc(id || "")}"><label>What do you need to do?<input name="title" value="${esc(c.title)}" required autofocus maxlength="200"></label><div class="input-grid"><label>Date<input name="date" type="date" value="${c.date}" required></label><label>Duration · minutes<input name="duration" type="number" min="1" max="1440" value="${c.duration}" required></label></div><label>Location<input name="location" list="places" value="${esc(c.location)}" placeholder="Grossman dorm, a building, or Online"></label><label>Timing<select name="timing"><option value="flex" ${c.fixedStart === null ? "selected" : ""}>Flexible · find a time</option><option value="fixed" ${c.fixedStart !== null ? "selected" : ""}>Fixed · keep this time</option></select></label><div id="fixed-fields" ${c.fixedStart === null ? "hidden" : ""}><label>Start time<input name="fixedStart" type="time" value="${timeInput(c.fixedStart ?? 720)}"></label></div><div id="flex-fields" class="input-grid" ${c.fixedStart !== null ? "hidden" : ""}><label>Earliest start<input name="earliest" type="time" value="${timeInput(c.earliest ?? 540)}"></label><label>Finish by<input name="latest" type="time" value="${timeInput(c.latest ?? 1260)}"></label></div><p class="fine-print">Saved only in Planner. Google Calendar events remain fixed and are edited in Calendar.</p><p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-action="close">Cancel</button><button class="primary" type="submit">Save commitment</button></div></form>`,
  );
}
function updateStatus() {
  $("sync-status").textContent = cloud?.status || "Saved on this device";
  const status = $("settings-sync-status");
  if (status) status.textContent = cloud?.status || "Saved on this device";
}
async function refreshCalendar(force = false) {
  if (calendarBusy || !auth?.getToken() || !state) return;
  const from = selectedDate < dateISO() ? selectedDate : dateISO(),
    until = addDays(selectedDate > dateISO() ? selectedDate : dateISO(), 28);
  const ids = state.settings.googleCalendarIds.filter((id) => {
    const c = state.calCache[id];
    return (
      force ||
      !c ||
      c.from > from ||
      c.until < until ||
      Date.now() - c.updatedAt >= 15 * 60000
    );
  });
  if (!ids.length) return;
  calendarBusy = true;
  const results = await Promise.allSettled(
    ids.map((calendarId) =>
      fetchCalendar({ calendarId, from, until, token: auth.getToken() }),
    ),
  );
  const failures = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason.message);
  lastCalendarError = failures.join(" ");
  try {
    commit(
      (s) => {
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            s.calCache[ids[index]] = result.value;
            s.settings.locationOverrides = mechanicsOverrides(
              result.value.events,
              s.settings.locationOverrides,
            );
          }
        });
      },
      null,
      { cacheOnly: true, render: false },
    );
  } catch (e) {
    lastCalendarError = e.message;
  }
  calendarBusy = false;
  if (!isEditing()) render();
  if (force && lastCalendarError) toast(lastCalendarError);
}
function sendFrameHello() {
  const frame = $("workout-frame");
  if (!frame.src || !state) return;
  const origin = new URL(frame.src).origin;
  // Authentication is shared only with the sibling app on this origin.
  // A restored custom iframe URL must never receive a Google access token.
  if (origin !== location.origin) return;
  frame.contentWindow.postMessage(
    { type: "planner:hello", clientId: state.settings.googleClientId },
    origin,
  );
  if (auth?.getToken())
    frame.contentWindow.postMessage(
      {
        type: "planner:token",
        token: auth.getToken(),
        expiresAt: auth.expiresAt,
      },
      origin,
    );
}
function setupConnections() {
  auth = new GoogleAuth({
    clientId: state.settings.googleClientId,
    scopes: `${DRIVE_SCOPE} ${CALENDAR_SCOPE}`,
    onChange: (error) => {
      if (error) toast(error);
      else {
        sendFrameHello();
        cloud?.sync();
        refreshCalendar(true);
      }
      updateStatus();
    },
  });
  // Reuse a still-valid previous app token without opening a sign-in popup.
  if (!auth.getToken()) {
    try {
      const old = JSON.parse(localStorage.getItem("day_google_tok"));
      if (old?.t && old.exp > Date.now()) {
        auth.accept(old.t, old.exp, false);
        localStorage.removeItem("day_google_tok");
      }
    } catch {
      /* Explicit reconnect remains available. */
    }
  }
  try {
    cloud = new DriveSync({
      app: "planner-v2",
      storage: localStorage,
      getToken: () => auth.getToken(),
      getSnapshot: () => plannerEntities(state),
      hasLocalData: () =>
        state.version > 0 ||
        state.commitments.length > 0 ||
        Object.keys(state.runs).length > 0,
      applySnapshot: async (entities) => {
        if (isEditing())
          throw Error(
            "Cloud changes are ready. Finish editing, then refresh to apply them.",
          );
        applyingCloud = true;
        try {
          commit(
            (s) => Object.assign(s, adoptPlannerEntities(s, entities)),
            null,
            { render: false },
          );
          auth.clientId = state.settings.googleClientId;
          render();
        } finally {
          applyingCloud = false;
        }
      },
      onStatus: updateStatus,
    });
  } catch (e) {
    toast(e.message);
  }
  let url = state.settings.workoutAppUrl;
  if (
    ["127.0.0.1", "localhost"].includes(location.hostname) &&
    url === defaults().settings.workoutAppUrl
  )
    url = `${location.origin}/oly-tracker/`;
  $("workout-frame").src = safeUrl(url);
  $("open-workout").href = safeUrl(url);
  $("workout-frame").addEventListener("load", sendFrameHello);
  window.addEventListener("message", (event) => {
    if (
      event.source !== $("workout-frame").contentWindow ||
      event.origin !== new URL($("workout-frame").src).origin
    )
      return;
    if (event.data?.type === "oly:disconnected") {
      auth.disconnect();
      updateStatus();
      return;
    }
    if (event.data?.type !== "oly:planner-feed") return;
    try {
      const next = validateFeed(event.data);
      if (feed && next.generatedAt < feed.generatedAt) return;
      feed = next;
      feedError = "";
      localStorage.setItem(FEED_KEY, JSON.stringify(feed));
      cache.clear();
      if (!isEditing() && view !== "morning") render();
    } catch (e) {
      feedError = e.message;
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === FEED_KEY && event.newValue) {
      try {
        feed = validateFeed(JSON.parse(event.newValue));
        cache.clear();
        if (!isEditing() && view !== "morning") render();
      } catch (e) {
        feedError = e.message;
      }
    }
    if (event.key === KEY) {
      if (isEditing())
        toast(
          "Planner changed in another tab. Finish or cancel your edit, then reload.",
        );
      else {
        try {
          state = loadState(localStorage).state;
          cache.clear();
          render();
        } catch (e) {
          toast(e.message);
        }
      }
    }
  });
  setTimeout(() => {
    cloud?.capture();
    if (auth.getToken()) {
      cloud?.sync();
      refreshCalendar();
    }
  }, 100);
}
function showConflicts() {
  const conflicts = cloud?.conflicts || [];
  modal(
    "Resolve sync conflicts",
    `<p>Both versions remain in private revision history. Independent edits are merged automatically.</p>${conflicts.map((c, i) => `<section class="card"><h3>${esc(c.key.startsWith("routine:") ? `Morning progress · ${c.key.slice(8)}` : c.key.startsWith("commitment:") ? "Commitment" : c.key)}</h3>${c.variants.map((v, j) => `<details><summary>Version ${j + 1} · ${esc(new Date(v.at).toLocaleString())}${v.writer === cloud.meta.writer ? " · this device" : " · another device"}</summary><pre>${esc(v.deleted ? "Deleted" : JSON.stringify(v.value, null, 2))}</pre></details><button data-action="resolve" data-id="${i}:${j}">Use version ${j + 1}</button>`).join("")}</section>`).join("") || "<p>No unresolved conflicts.</p>"}`,
  );
}
function exportFile(data, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function action(button) {
  const { action: type, id } = button.dataset;
  if (type === "close") return closeModal();
  if (type === "previous-day" || type === "next-day") {
    selectedDate = addDays(selectedDate, type === "previous-day" ? -1 : 1);
    render();
    refreshCalendar();
    return;
  }
  if (type === "today") return navigate("today", dateISO());
  if (type === "open-day") return navigate("today", button.dataset.date);
  if (type === "add" || type === "edit") return commitmentForm(id);
  if (type === "connect") {
    if (!state.settings.googleClientId) {
      navigate("settings");
      $("page-settings").querySelector('[name="clientId"]').focus();
      toast(
        "Enter the same Google OAuth client ID used by your existing apps, then connect.",
      );
      return;
    }
    auth.connect();
    return;
  }
  if (type === "disconnect") {
    auth.disconnect();
    $("workout-frame").contentWindow.postMessage(
      { type: "planner:disconnect" },
      new URL($("workout-frame").src).origin,
    );
    render();
    return;
  }
  if (type === "refresh") {
    cache.clear();
    await Promise.allSettled([refreshCalendar(true), cloud?.sync()]);
    sendFrameHello();
    render();
    return;
  }
  if (type === "delete") {
    const c = state.commitments.find((c) => c.id === id);
    undo = { kind: "commitment", value: structuredClone(c) };
    commit((s) => {
      s.commitments = s.commitments.filter((c) => c.id !== id);
      delete s.activities[id];
    }, "Commitment deleted. Undo is available in Settings.");
    return;
  }
  if (type === "undo") {
    if (!undo) return;
    const value = undo;
    undo = null;
    commit((s) => {
      if (value.kind === "commitment") s.commitments.push(value.value);
      if (value.kind === "route") s.settings.routes[value.id] = value.value;
      if (value.kind === "hours") s.settings.hours.push(value.value);
    }, "Restored.");
    return;
  }
  if (type === "routine-start") {
    if (selectedDate !== dateISO())
      throw Error("Start a live routine on today’s date.");
    commit((s) => {
      s.runs[selectedDate] = startRun(
        selectedDate,
        Date.now(),
        s.settings.routineDurations,
      );
    }, "Morning started. Progress saves after every step.");
    return;
  }
  if (type.startsWith("step-")) {
    commit((s) => {
      const run = s.runs[selectedDate];
      if (!run) throw Error("Start the routine first.");
      s.runs[selectedDate] =
        type === "step-pause"
          ? pauseRun(run)
          : type === "step-undo"
            ? undoStep(run)
            : finishStep(run, Date.now(), type === "step-skip");
      const updated = s.runs[selectedDate];
      s.routineHistory = s.routineHistory.filter((r) => r.id !== updated.id);
      if (updated.finishedAt)
        s.routineHistory.push({
          id: updated.id,
          date: updated.date,
          startedAt: updated.startedAt,
          finishedAt: updated.finishedAt,
          steps: updated.completed,
        });
    });
    return;
  }
  if (type.startsWith("activity-")) {
    const b = resultFor(selectedDate).primary.find((b) => b.id === id);
    if (!b) throw Error("That activity has changed; refresh the day.");
    if (selectedDate !== dateISO())
      throw Error("Record live progress on today’s date.");
    commit((s) => {
      if (type === "activity-replan") {
        s.activities[id] = { status: "replan" };
        placements[selectedDate] = (placements[selectedDate] || []).filter(
          (x) => x.id !== id,
        );
      } else if (type === "activity-start")
        s.activities[id] = {
          status: "active",
          startedAt: Date.now(),
          location: b.location,
        };
      else
        s.activities[id] = {
          status: "complete",
          startedAt:
            s.activities[id]?.startedAt ||
            Math.min(b.start * 60000, Date.now()),
          endedAt: Date.now(),
          location: b.location,
        };
    });
    return;
  }
  if (type === "event-location") {
    const e = resultFor(selectedDate).primary.find((e) => e.id === id);
    modal(
      "Where is this commitment?",
      `<form data-form="event-location" data-id="${esc(id)}" data-series="${esc(e.seriesId ? `series:${e.calendarId}:${e.seriesId}` : "")}"><p>${esc(e.title)}</p><label>Building or location<input name="location" list="places" value="${esc(e.location)}" required></label>${e.seriesId ? `<label><input type="checkbox" name="series" checked>Use for this recurring class</label>` : ""}<p class="fine-print">This is a Planner location override. The Google Calendar event is unchanged.</p><p class="form-error" role="alert"></p><div class="form-actions"><button class="primary" type="submit">Save location</button></div></form>`,
    );
    return;
  }
  if (type === "route-delete") {
    undo = { kind: "route", id, value: state.settings.routes[id] };
    commit((s) => {
      delete s.settings.routes[id];
    }, "Walking override removed.");
    return;
  }
  if (type === "hours-delete") {
    undo = { kind: "hours", value: state.settings.hours[Number(id)] };
    commit((s) => {
      s.settings.hours.splice(Number(id), 1);
    }, "Hours override removed.");
    return;
  }
  if (type === "route-fetch") {
    const form = button.closest("form"),
      data = new FormData(form),
      from = resolvePlace(data.get("from"), state.settings.places),
      to = resolvePlace(data.get("to"), state.settings.places);
    if (!state.settings.tomtomKey)
      throw Error(
        "Save a TomTom API key below to calculate a walking route, or enter your own door-to-door minutes.",
      );
    if (from.id === to.id) throw Error("Choose two different places.");
    button.disabled = true;
    delete form.dataset.dirty;
    try {
      const url = new URL(
        `https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json`,
      );
      url.search = new URLSearchParams({
        key: state.settings.tomtomKey,
        travelMode: "pedestrian",
        routeType: "fastest",
        traffic: "false",
      });
      const response = await fetch(url);
      if (!response.ok)
        throw Error(
          `Walking route unavailable (HTTP ${response.status}). Existing estimates are preserved.`,
        );
      const route = (await response.json()).routes?.[0]?.summary;
      if (!Number.isFinite(route?.travelTimeInSeconds))
        throw Error("The routing service did not return a walking duration.");
      const minutes = Math.max(
        4,
        Math.ceil(route.travelTimeInSeconds / 60) + 4,
      );
      commit((s) => {
        s.settings.routes[routeKey(from.id, to.id)] = {
          minutes,
          basis: "routed",
          provider: "TomTom pedestrian",
          retrievedAt: Date.now(),
          walkingSeconds: route.travelTimeInSeconds,
          transitionMinutes: 4,
        };
      }, `Walking route saved: ${minutes} minutes, including four minutes for building transitions.`);
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (type === "export")
    return exportFile(
      { ...state, exportedAt: new Date().toISOString() },
      `planner-${dateISO()}.json`,
    );
  if (type === "export-legacy")
    return exportFile(
      JSON.parse(localStorage.getItem(MIGRATION)),
      "planner-before-rebuild.json",
    );
  if (type === "conflicts") return showConflicts();
  if (type === "resolve") {
    const [i, j] = id.split(":").map(Number),
      c = cloud.conflicts[i];
    closeModal();
    await cloud.resolve(c.key, c.variants[j].revision);
    showConflicts();
    return;
  }
  if (type === "check-update") {
    await updateRegistration?.update();
    toast(
      updateRegistration?.waiting
        ? "An update is ready. Use the update banner when your active sessions are finished."
        : "Update check complete.",
    );
    return;
  }
  if (type === "update") {
    if (
      Object.values(state.runs).some((r) => !r.finishedAt) ||
      feed?.entries.some((e) => e.active) ||
      Object.values(state.activities).some((a) => a.status === "active")
    )
      throw Error(
        "Finish your active routine or workout before loading the app update.",
      );
    acceptedUpdate = true;
    updateRegistration?.waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
  }
}
function handleForm(form) {
  const data = new FormData(form),
    type = form.dataset.form;
  delete form.dataset.dirty;
  const text = (name) => String(data.get(name) || "").trim();
  if (type === "commitment") {
    const fixed = text("timing") === "fixed",
      c = {
        id: form.dataset.id || crypto.randomUUID(),
        title: text("title"),
        date: text("date"),
        duration: Number(data.get("duration")),
        location: text("location") || "grossman",
        fixedStart: fixed ? clockMinutes(text("fixedStart")) : null,
        earliest: clockMinutes(text("earliest")),
        latest: clockMinutes(text("latest")),
      };
    if (fixed && c.fixedStart === null)
      throw Error("Enter a valid start time.");
    if (
      !fixed &&
      (c.earliest === null || c.latest === null || c.latest <= c.earliest)
    )
      throw Error("Enter an earliest start before the finish-by time.");
    selectedDate = c.date;
    view = "today";
    commit(
      (s) => {
        s.commitments = s.commitments.filter((x) => x.id !== c.id);
        s.commitments.push(c);
        delete s.activities[c.id];
        placements[c.date] = (placements[c.date] || []).filter(
          (b) => b.id !== c.id,
        );
      },
      "Commitment saved in Planner.",
      { render: false },
    );
    closeModal();
    render();
    return;
  }
  if (type === "google") {
    commit((s) => {
      s.settings.googleClientId = text("clientId");
      s.settings.googleCalendarIds = [
        ...new Set(
          text("calendars")
            .split(/[\n,]/)
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ];
      if (!s.settings.googleCalendarIds.length)
        s.settings.googleCalendarIds = ["primary"];
    }, "Connection settings saved.");
    auth.clientId = state.settings.googleClientId;
    sendFrameHello();
    return;
  }
  if (type === "preferences") {
    commit((s) => {
      s.settings.returnHomeDuringBreaks = data.has("homeBreaks");
      s.settings.wakeTime = text("wake");
      for (const id of ["breakfast", "lunch", "dinner"])
        s.settings.mealMinutes[id] = Number(data.get(id));
    }, "Daily timing updated.");
    return;
  }
  if (type === "routine-timing") {
    commit((s) => {
      s.settings.routineDurations = Object.fromEntries(
        [...data].map(([key, value]) => [key, Number(value) * 60]),
      );
      s.settings.routineDurations.cold = 180;
    }, "Future morning allowances updated.");
    return;
  }
  if (type === "route") {
    const from = text("from"),
      to = text("to");
    if (from === to) throw Error("Choose two different places.");
    commit((s) => {
      s.settings.routes[routeKey(from, to)] = {
        minutes: Number(data.get("minutes")),
        basis: "personal override",
        updatedAt: Date.now(),
      };
    }, "Door-to-door walking time saved.");
    return;
  }
  if (type === "routing-key") {
    commit((s) => {
      s.settings.tomtomKey = text("key");
    }, "Routing key saved on this device.");
    return;
  }
  if (type === "place") {
    const place = {
      label: text("label"),
      address: text("address"),
      lat: Number(data.get("lat")),
      lon: Number(data.get("lon")),
      aliases: [text("label").toLowerCase()],
    };
    commit((s) => {
      s.settings.places[`place-${crypto.randomUUID()}`] = place;
    }, "Building added.");
    return;
  }
  if (type === "hours") {
    const intervals = text("intervals")
      ? text("intervals")
          .split(",")
          .map((range) => {
            const values = range
              .trim()
              .split(/[-–]/)
              .map((v) => v.trim());
            if (values.length !== 2)
              throw Error(
                "Use intervals such as 07:00-21:00, separated by commas.",
              );
            const pair = values.map((v) =>
              v === "24:00" ? 1440 : clockMinutes(v),
            );
            if (pair.some((v) => v === null) || pair[1] <= pair[0])
              throw Error("Each closing time must follow its opening time.");
            return pair;
          })
      : [];
    commit((s) => {
      s.settings.hours.push({
        place: text("place"),
        from: text("from"),
        until: text("until"),
        intervals,
        source: text("source") || "Personal verified hours",
        verified: true,
      });
    }, "Dated facility hours saved.");
    return;
  }
  if (type === "event-location") {
    const key =
        data.has("series") && form.dataset.series
          ? form.dataset.series
          : form.dataset.id,
      value = text("location");
    closeModal();
    commit((s) => {
      s.settings.locationOverrides[key] = value;
    }, "Location saved in Planner.");
  }
}
function tick() {
  const countdown = $("departure-countdown");
  if (countdown) {
    const left = Math.ceil(Number(countdown.dataset.at) - Date.now() / 60000);
    countdown.textContent =
      left > 0 ? `${left} min remaining` : "Time to leave";
  }
  const run = state?.runs[selectedDate];
  if (!run || run.finishedAt || view !== "morning") return;
  const element = $("morning-clock");
  if (element)
    element.textContent = clock(
      run.steps[run.index].seconds - elapsedStep(run),
    );
  const status = $("morning-status");
  if (status)
    status.textContent =
      Date.now() < run.currentStartedAt
        ? `Bathroom reserved from ${formatTime(run.currentStartedAt / 60000)} · wait before starting`
        : run.pausedAt !== null
          ? "Paused · the day’s clock continues"
          : elapsedStep(run) >= run.steps[run.index].seconds
            ? "Allowance reached. Finish the step, then continue."
            : "Finish the step, then continue.";
  const masque = $("masque-clock");
  if (masque && run.masqueStartedAt)
    masque.textContent = `Masque processing · ${clock((Date.now() - run.masqueStartedAt) / 1000)} elapsed during other steps`;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) return navigate(button.dataset.view);
  if (button.dataset.action)
    Promise.resolve(action(button)).catch((e) => toast(e.message));
});
document.addEventListener("input", (event) => {
  const form = event.target.closest("form[data-form]");
  if (form) form.dataset.dirty = "true";
});
document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  try {
    handleForm(form);
  } catch (e) {
    form.dataset.dirty = "true";
    const error = form.querySelector(".form-error");
    if (error?.isConnected) {
      error.textContent = e.message;
      error.scrollIntoView({ block: "nearest" });
    } else toast(e.message);
  }
});
document.addEventListener("change", async (event) => {
  if (event.target.id === "selected-date") {
    selectedDate = event.target.value || dateISO();
    render();
    refreshCalendar();
  }
  if (event.target.name === "timing") {
    $("fixed-fields").hidden = event.target.value !== "fixed";
    $("flex-fields").hidden = event.target.value !== "flex";
  }
  if (event.target.id === "import-backup") {
    try {
      const file = event.target.files[0];
      if (!file) return;
      const imported = validate(JSON.parse(await file.text()));
      const expected = state?.version || 0;
      state = saveState(
        localStorage,
        { ...imported, version: expected },
        expected,
      );
      storageError = "";
      cache.clear();
      placements = {};
      if (!auth) setupConnections();
      cloud?.capture();
      render();
      toast(
        "Backup restored. The previous valid state remains in the local backup.",
      );
    } catch (e) {
      toast(e.message);
    }
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state) {
    cache.clear();
    refreshCalendar();
    cloud?.sync();
    sendFrameHello();
    if (!$("dialog").open && view !== "settings") render();
  }
});
window.addEventListener("online", () => {
  refreshCalendar();
  cloud?.sync();
});
let tickMinute = Math.floor(Date.now() / 60000);
setInterval(() => {
  tick();
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== tickMinute) {
    tickMinute = minute;
    if (state && !document.hidden && view === "today" && !isEditing()) render();
  }
}, 1000);
setInterval(() => {
  if (!document.hidden) {
    refreshCalendar();
    cloud?.sync();
  }
}, 60000);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js", { updateViaCache: "none" })
    .then((registration) => {
      updateRegistration = registration;
      const announce = () => {
        $("update-banner").hidden =
          !registration.waiting || !navigator.serviceWorker.controller;
      };
      announce();
      registration.addEventListener("updatefound", () =>
        registration.installing?.addEventListener("statechange", announce),
      );
    })
    .catch(() => {
      /* Online app remains available; no false offline-ready claim. */
    });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (acceptedUpdate) location.reload();
  });
}
if (state) setupConnections();
render();
