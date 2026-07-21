'use strict';
// ─── Day — Life Manager: views, navigation & init ─────────────────────────────

let CUR = "Today";
const TABS = ["Today", "Morning", "Night", "Workout", "Settings"];

function render() {
  normalizeData();
  // leaving a routine tab: stop its clock + hide the background chip
  if (!isRoutineTab(CUR)) { if (routineInt) { clearInterval(routineInt); routineInt = null; } const bb = $("#bgbar"); if (bb) bb.classList.remove("show"); updateWake(); }
  renderTabs();
  const v = $("#view");
  $("#statline").textContent = statline();
  if (CUR === "Today") { v.innerHTML = todayView(); bindToday(); kickTodayData(); return; }
  if (isRoutineTab(CUR)) { v.innerHTML = routineView(); bindRoutine(); return; }
  if (CUR === "Workout") { v.innerHTML = workoutView(); bindWorkout(); return; }
  if (CUR === "Settings") { v.innerHTML = settingsView(); bindSettings(); return; }
}
function statline() {
  if (CUR === "Today") { const d = new Date(); return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); }
  if (CUR === "Morning") return "Morning routine · " + todayDOW();
  if (CUR === "Night") return "Nighttime routine";
  if (CUR === "Workout") return "Workout timing";
  return "Settings & connections";
}
function renderTabs() {
  const t = $("#tabs"); t.innerHTML = "";
  TABS.forEach(name => {
    const b = document.createElement("button");
    b.className = "tab" + (name === CUR ? " active" : "");
    b.textContent = name;
    b.onclick = () => { if (typeof captureOlyState === "function") captureOlyState(); CUR = name; editMode = false; render(); };
    t.appendChild(b);
  });
}
function go(tab) { CUR = tab; editMode = false; render(); }

// ─── Today: master timeline ───────────────────────────────────────────────────
const SEG_ICON = { routine: "🧴", travel: "🚗", workout: "🏋", event: "📅", task: "✅", free: "·" };
function segIcon(s) { if (s.type === "workout") return "🏋"; if (s.type === "routine") return s.go === "Night" ? "🌙" : "🌅"; return SEG_ICON[s.type] || "•"; }

function todayView() {
  const tl = computeTimeline(todayISO());
  const plan = dayPlan(todayISO());
  let h = "";

  // summary card
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  h += `<div class="hero">
    <div class="hero-row">
      <div><div class="hero-k">Wake</div><div class="hero-v">${fmtClock(tl.wakeMin)}</div></div>
      <div><div class="hero-k">Bed</div><div class="hero-v">${fmtClock(tl.bedMin)}</div></div>
      <div><div class="hero-k">Busy</div><div class="hero-v">${Math.floor(tl.busyMin / 60)}h ${tl.busyMin % 60}m</div></div>
    </div>`;
  if (tl.leaveBy) h += `<div class="hero-leave">⏱ Leave by <b>${fmtClock(tl.leaveBy.min)}</b> → ${escapeHtml(tl.leaveBy.label)}</div>`;
  if (tl.wakeBy != null && tl.wakeBy < tl.wakeMin) h += `<div class="hero-warn">⚠ Wake by <b>${fmtClock(tl.wakeBy)}</b> to make your first commitment on time.</div>`;
  else if (tl.wakeBy != null) h += `<div class="hero-leave">First commitment is covered — wake by ${fmtClock(tl.wakeBy)} leaves you on time.</div>`;
  h += `</div>`;

  // night-before look-ahead (evening only on the Today tab)
  h += lookAheadHTML(false);

  // conflicts
  if (tl.conflicts.length) {
    h += `<div class="card alert"><div class="alert-h">⚠ ${tl.conflicts.length} conflict${tl.conflicts.length !== 1 ? "s" : ""} to resolve</div>`;
    tl.conflicts.forEach(c => h += `<div class="alert-l">• ${escapeHtml(c)}</div>`);
    h += `</div>`;
  }
  // all-day banner
  if (tl.allDayEvents.length) {
    h += `<div class="card allday"><b>All-day:</b> ${tl.allDayEvents.map(e => escapeHtml(e.title)).join(" · ")}</div>`;
  }
  // data status hints
  const dataHints = [];
  const haveCalSrc = DATA.settings.googleCalEnabled || (DATA.settings.outlookIcsUrl || "").trim();
  if (!haveCalSrc && !cachedEventsFor(todayISO()).length) dataHints.push("Connect a calendar in Settings to pull your events.");
  if (!DATA.settings.homeAddress) dataHints.push("Add your home address in Settings for travel time.");
  if (dataHints.length) h += `<div class="card hintcard">${dataHints.map(d => "• " + escapeHtml(d)).join("<br>")}</div>`;

  // timeline
  h += `<div class="cardhd row"><b>Timeline</b><button class="chipbtn" id="refreshBtn">↻ Refresh</button></div>`;
  h += `<div class="tl">`;
  tl.segments.forEach(s => {
    const clickable = s.go ? ` data-go="${s.go}"` : (s.taskId ? ` data-task="${s.taskId}"` : "");
    h += `<div class="tlrow ${s.type} ${s.status}"${clickable}>
      <div class="tltime">${fmtClock(s.start)}<span>${fmtClock(s.end)}</span></div>
      <div class="tlbody">
        <div class="tllabel">${segIcon(s)} ${escapeHtml(s.label)}${badgeFor(s)}</div>
        ${s.sub ? `<div class="tlsub">${escapeHtml(s.sub)}</div>` : ""}
      </div></div>`;
  });
  h += `</div>`;

  // one-off controls
  h += `<div class="card"><div class="cardhd"><b>Today's adjustments</b></div>
    <div class="frow"><label>Wake time</label><input type="time" id="tWake" class="sel" value="${minToHM(tl.wakeMin % 1440)}"></div>
    <div class="frow"><label>Bedtime</label><input type="time" id="tBed" class="sel" value="${minToHM(tl.bedMin % 1440)}"></div>`;
  if (tl.workMin > 0 || workoutSkippedFor(todayISO())) {
    h += `<div class="frow"><label>Gym departure</label><input type="time" id="tDepart" class="sel" value="${minToHM(workoutDepartMin(todayISO()))}"></div>
    <div class="frow"><label>Skip workout today</label><input type="checkbox" id="tSkip" ${workoutSkippedFor(todayISO()) ? "checked" : ""}></div>`;
  }
  // night routine: at its usual start time, or moved before you go out
  const nMode = plan.nightMode === "beforeOut" ? "beforeOut" : "usual";
  const evDeparts = tl.segments.filter(s => s.type === "travel" && s.label.indexOf("home") < 0 && (s.start % 1440) >= 16 * 60);
  const suggestOut = evDeparts.length ? minToHM(evDeparts[evDeparts.length - 1].start % 1440) : "20:00";
  h += `<div class="frow"><label>Night routine</label>
    <select id="tNightMode" class="sel">
      <option value="bed" ${nMode === "usual" ? "selected" : ""}>Usual time</option>
      <option value="beforeOut" ${nMode === "beforeOut" ? "selected" : ""}>Before I go out</option>
    </select></div>`;
  if (nMode === "beforeOut") h += `<div class="frow"><label>Finish before I leave at</label><input type="time" id="tNightOut" class="sel" value="${plan.nightOutTime || suggestOut}"></div>`;
  else h += `<div class="frow"><label>Night routine starts at</label><input type="time" id="tNightAt" class="sel" value="${plan.nightTime || DATA.settings.nightTime || "20:00"}"></div>`;
  h += `</div>`;

  // ad-hoc tasks
  h += `<div class="card"><div class="cardhd"><b>One-off tasks &amp; plans</b></div>`;
  if (plan.tasks.length) {
    plan.tasks.forEach(t => {
      h += `<div class="taskrow"><div><b>${escapeHtml(t.name)}</b> <span class="muted">${t.durMin || 30}m${t.fixedStart ? " @ " + fmtClock(hmToMin(t.fixedStart)) : ""}${t.location ? " · " + escapeHtml(t.location) : ""}</span></div><button class="chipbtn taskdel" data-del="${t.id}" style="color:var(--red)">×</button></div>`;
    });
  } else h += `<div class="muted" style="margin-bottom:8px">Nothing extra today. Add a one-off below — it slots into your timeline automatically.</div>`;
  h += `<div class="addtask">
      <input id="ntName" placeholder="e.g. Dentist, call landlord, groceries" class="sel" style="width:100%">
      <div class="addrow">
        <div class="fld"><label>min</label><input id="ntDur" type="number" inputmode="numeric" value="30" style="width:64px"></div>
        <div class="fld"><label>at (optional)</label><input id="ntTime" type="time" class="sel"></div>
        <div class="fld" style="flex:1"><label>where (optional)</label><input id="ntLoc" placeholder="address" class="sel" style="width:100%"></div>
      </div>
      <div class="hint" style="margin:2px 0 0">Enter how long it'll take. Add a time to pin it, or leave the time blank to let the timeline slot it into your open time. For automatic time estimates, ask Claude to add it to your calendar — it'll flow in here.</div>
      <button class="btn primary" id="ntAdd">+ Add to today</button>
    </div></div>`;
  return h;
}
function badgeFor(s) {
  if (s.status === "conflict") return ` <span class="bdg red">conflict</span>`;
  if (s.status === "moved") return ` <span class="bdg amber">moved</span>`;
  if (s.status === "tight") return ` <span class="bdg amber">tight</span>`;
  if (s.flex) return ` <span class="bdg green">plan</span>`;
  if (s.source === "outlook") return ` <span class="bdg blue">school</span>`;
  if (s.source === "google") return ` <span class="bdg green">cal</span>`;
  return "";
}
// ─── Night-before look-ahead ──────────────────────────────────────────────────
// Reads tomorrow's calendar and, if a morning commitment would clash with the
// morning routine, tells you the wake-by time and offers: wake earlier, move
// reading to its own block, or both. Shown in the evening on Today + on Night start.
function lookAheadHTML(force) {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  if (!force && nowMin < 17 * 60) return ""; // only surfaces in the evening on Today
  const tISO = tomorrowISO();
  const tl = computeTimeline(tISO);
  if (!tl.morningClash || !tl.firstCommit) return "";
  const fc = tl.firstCommit;
  const dowName = new Date(tISO + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" });
  const wakeByClock = fmtClock(tl.wakeBy);
  const p = DATA.dayPlans[tISO] || {};
  const readingInRoutine = routineSteps(DATA.routineConfig, dowForISO(tISO)).some(s => s.id === "read");
  const readingDropped = (p.dropSteps || []).indexOf("read") >= 0;
  let h = `<div class="card lookahead"><div class="la-h">🌙 Heads up for tomorrow (${dowName})</div>
    <div class="la-l"><b>${escapeHtml(fc.title)}</b> at ${fmtClock(fc.startMin)}${fc.travelMin ? " · " + fc.travelMin + " min away" : ""} starts before your morning routine would finish.</div>
    <div class="la-l">To keep your full routine, <b>wake by ${wakeByClock}</b>.</div>
    <div class="la-btns">
      <button class="btn primary sm" id="laWake">Set tomorrow's wake to ${wakeByClock}</button>`;
  if (readingInRoutine && !readingDropped) h += `<button class="btn ghost sm" id="laDropRead">Move reading to its own block</button>`;
  h += `</div>`;
  if (readingDropped) h += `<div class="la-note">✓ Reading is moved into its own block tomorrow (routine ends earlier). <a id="laUndo">undo</a></div>`;
  return h + `</div>`;
}
function bindLookAhead() {
  const lw = $("#laWake"); if (lw) lw.onclick = () => {
    const tISO = tomorrowISO(), tl = computeTimeline(tISO);
    if (tl.wakeBy == null) return;
    dayPlan(tISO).wakeTime = minToHM(((tl.wakeBy % 1440) + 1440) % 1440);
    persist("Tomorrow's wake set"); render();
  };
  const ld = $("#laDropRead"); if (ld) ld.onclick = () => {
    const p = dayPlan(tomorrowISO());
    p.dropSteps = Array.from(new Set([...(p.dropSteps || []), "read"]));
    if (!p.tasks.some(t => t.id === "read_moved")) p.tasks.push({ id: "read_moved", name: "Read + take notes — 2 chapters", durMin: 90, fixedStart: null, location: "" });
    persist("Reading moved to its own block"); render();
  };
  const lu = $("#laUndo"); if (lu) lu.onclick = () => {
    const p = dayPlan(tomorrowISO());
    p.dropSteps = (p.dropSteps || []).filter(x => x !== "read");
    p.tasks = p.tasks.filter(t => t.id !== "read_moved");
    persist("Reading restored to the routine"); render();
  };
}

function bindToday() {
  bindLookAhead();
  const rb = $("#refreshBtn"); if (rb) rb.onclick = () => { delete DATA.calCache[todayISO()]; refreshCalendars(todayISO()); const tl = computeTimeline(todayISO()); if (tl.pending.length) prefetchTravel(tl.pending); toast("Refreshing…"); };
  $$(".tlrow[data-go]").forEach(r => r.onclick = () => go(r.dataset.go));
  $$(".taskdel").forEach(b => b.onclick = () => { const p = dayPlan(todayISO()); p.tasks = p.tasks.filter(t => t.id !== b.dataset.del); persist("Task removed"); render(); });
  const tw = $("#tWake"); if (tw) tw.onchange = () => { dayPlan(todayISO()).wakeTime = tw.value; persist("Wake set"); render(); };
  const tb = $("#tBed"); if (tb) tb.onchange = () => { dayPlan(todayISO()).bedTime = tb.value; persist("Bedtime set"); render(); };
  const td = $("#tDepart"); if (td) td.onchange = () => { dayPlan(todayISO()).workoutDepart = td.value; persist("Departure set"); render(); };
  const ts = $("#tSkip"); if (ts) ts.onchange = () => { dayPlan(todayISO()).workoutSkip = ts.checked; persist(ts.checked ? "Workout skipped" : "Workout back on"); render(); };
  const tnm = $("#tNightMode"); if (tnm) tnm.onchange = () => {
    const p = dayPlan(todayISO()); p.nightMode = tnm.value;
    if (tnm.value === "beforeOut" && !p.nightOutTime) {
      const tl2 = computeTimeline(todayISO());
      const ev = tl2.segments.filter(s => s.type === "travel" && s.label.indexOf("home") < 0 && (s.start % 1440) >= 16 * 60);
      p.nightOutTime = ev.length ? minToHM(ev[ev.length - 1].start % 1440) : "20:00";
    }
    persist("Night routine set"); render();
  };
  const tno = $("#tNightOut"); if (tno) tno.onchange = () => { dayPlan(todayISO()).nightOutTime = tno.value; persist("Leave-by set"); render(); };
  const tna = $("#tNightAt"); if (tna) tna.onchange = () => { dayPlan(todayISO()).nightTime = tna.value; persist("Night routine time set"); render(); };
  const na = $("#ntAdd"); if (na) na.onclick = () => {
    const name = ($("#ntName").value || "").trim(); if (!name) { toast("Name the task"); return; }
    const dur = parseInt($("#ntDur").value, 10) || 30;
    const fixed = $("#ntTime").value || null;
    const loc = ($("#ntLoc").value || "").trim();
    dayPlan(todayISO()).tasks.push({ id: "t" + Date.now(), name, durMin: dur, fixedStart: fixed, location: loc });
    persist("Task added"); render();
  };
}
// Background pulls for the Today view (calendars + travel), guarded so they settle.
let kickedFor = null, kickedTomorrowFor = null;
function calConfigured() { return (DATA.settings.googleCalEnabled && accessToken) || (DATA.settings.outlookIcsUrl || "").trim(); }
function kickDay(iso, guardGet, guardSet) {
  const cache = DATA.calCache[iso];
  const stale = !cache || (Date.now() - (cache.ts || 0) > 1000 * 60 * 20);
  if (calConfigured() && stale && guardGet() !== iso) { guardSet(iso); refreshCalendars(iso); }
  const tl = computeTimeline(iso);
  if (tl.pending.length) prefetchTravel(tl.pending);
}
function kickTodayData() {
  kickDay(todayISO(), () => kickedFor, v => kickedFor = v);
  // In the evening, also pull tomorrow so the night-before look-ahead has data.
  if (new Date().getHours() >= 17) kickDay(tomorrowISO(), () => kickedTomorrowFor, v => kickedTomorrowFor = v);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function settingsView() {
  const S = DATA.settings;
  let h = `<div class="daysub">Connections and defaults. Everything is stored on your device and synced to your private Google Drive file.</div>`;

  h += `<div class="card"><div class="cardhd"><b>Calendars</b></div>
    <div class="frow"><label>Google Client ID</label><input id="sCid" class="sel" style="width:100%" placeholder="…apps.googleusercontent.com" value="${escapeAttr(S.googleClientId || "")}"></div>
    <div class="frow"><label>Use Google Calendar</label><input type="checkbox" id="sGcal" ${S.googleCalEnabled ? "checked" : ""}></div>
    <div class="frow"><label>Google calendar IDs (fixed)</label><input id="sGids" class="sel" style="width:100%" placeholder="primary, you@group.calendar.google.com" value="${escapeAttr((S.googleCalendarIds || ["primary"]).join(", "))}"></div>
    <div class="frow"><label>Flexible work-block calendar IDs</label><input id="sFlex" class="sel" style="width:100%" placeholder="day-tasks@group.calendar.google.com" value="${escapeAttr((S.flexCalendarIds || []).join(", "))}"></div>
    <div class="hint">Events on a <b>flexible</b> calendar become work blocks: the app keeps their duration but slots them into your open time instead of pinning them. Have Claude's morning briefing drop the day's to-dos here with estimated durations (see WORKFLOW.md). Tutoring &amp; classes stay on your fixed calendars.</div>
    <button class="btn ghost" id="sConnect">Connect / refresh Google</button>
    <div class="hint">Tap the sync chip (top-right) any time to reconnect. Personal Google events + Drive sync use this one sign-in.</div>
    <hr>
    <div class="frow"><label>Outlook .ics feed URL</label><input id="sIcs" class="sel" style="width:100%" placeholder="https://outlook.office365.com/owa/calendar/.../calendar.ics" value="${escapeAttr(S.outlookIcsUrl || "")}"></div>
    <div class="frow"><label>CORS proxy (if feed is blocked)</label><input id="sProxy" class="sel" style="width:100%" placeholder="https://your-proxy/?url=" value="${escapeAttr(S.corsProxy || "")}"></div>
    <div class="hint">In Outlook → Calendar → Share → Publish, set "Can view all details", copy the <b>ICS</b> link here. If it won't load (CORS), add a proxy prefix.</div>
  </div>`;

  h += `<div class="card"><div class="cardhd"><b>Places &amp; travel</b></div>
    <div class="frow"><label>Home address</label><input id="sHome" class="sel" style="width:100%" value="${escapeAttr(S.homeAddress || "")}"></div>
    <div class="frow"><label>Gym address</label><input id="sGym" class="sel" style="width:100%" value="${escapeAttr(S.gymAddress || "")}"></div>
    <div class="frow"><label>Travel mode</label>
      <select id="sMode" class="sel">${["driving", "walking", "transit"].map(m => `<option ${S.travelMode === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    <div class="frow"><label>Fallback travel buffer</label><input id="sBuf" type="number" inputmode="numeric" class="sel" style="width:80px" value="${S.defaultTravelMin || 15}"> min</div>
    <div class="frow"><label>TomTom API key</label><input id="sTomKey" class="sel" style="width:100%" placeholder="free key from developer.tomtom.com" value="${escapeAttr(S.tomtomKey || "")}"></div>
    <div class="hint">Travel times use <b>real predicted / live traffic from TomTom</b> — priced for each trip's own departure time. Free tier, no credit card: sign up at developer.tomtom.com, create a key, paste it above. TomTom also geocodes your addresses (it handles business names like "Crunch Chamblee" that free maps miss). Until a real value loads you'll briefly see a rough <i>approx</i> placeholder; the <b>fallback buffer</b> above is only used when an address can't be located at all.</div>
    <div class="frow"><label>Google Maps key (optional)</label><input id="sMapKey" class="sel" style="width:100%" placeholder="leave blank to use free routing" value="${escapeAttr(S.mapsApiKey || "")}"></div>
    <div class="hint">Free mode uses OpenStreetMap + OSRM — no key, no cost. A Maps key adds live traffic & transit but may bill beyond Google's free tier.</div>
  </div>`;

  h += `<div class="card"><div class="cardhd"><b>Workout app</b></div>
    <div class="frow"><label>Embedded workout app URL</label><input id="sWkUrl" class="sel" style="width:100%" value="${escapeAttr(S.workoutAppUrl || "https://jonathandesta.github.io/oly-tracker/")}"></div>
    <div class="hint">The Workout tab embeds this app. Hosted on the same domain, it shares storage so the timeline reads your live block/week/cutting automatically.</div>
  </div>`;

  h += `<div class="card"><div class="cardhd"><b>Daily defaults</b></div>
    <div class="frow"><label>Default wake time</label><input type="time" id="sWake" class="sel" value="${S.wakeTime || "07:00"}"></div>
    <div class="frow"><label>Default bedtime</label><input type="time" id="sBed" class="sel" value="${S.bedTime || "23:00"}"></div>
    <div class="frow"><label>Night routine usually starts</label><input type="time" id="sNight" class="sel" value="${S.nightTime || "20:00"}"></div>
    <div class="hint">The timeline places the nighttime routine at this start time and slides it later on days when that slot is taken.</div>
  </div>`;

  h += `<div class="card"><div class="cardhd"><b>Data</b></div>
    <button class="btn ghost" id="sExport">Export backup (JSON)</button>
    <button class="btn ghost" id="sReset" style="margin-top:8px">Reset to my preset</button>
    <div class="hint">"Reset to my preset" restores home/gym, wake/bed, gym time, training days and travel prefs to your saved baseline. It does <b>not</b> touch your Google/Outlook/TomTom credentials. Version ${DATA.version} · last synced ${DATA.updated ? new Date(DATA.updated).toLocaleString() : "never"}.</div>
  </div>`;
  return h;
}
function bindSettings() {
  const S = DATA.settings;
  const bind = (id, fn) => { const e = $(id); if (e) e.onchange = () => { fn(e.value); persist("Saved"); render(); }; };
  bind("#sCid", v => S.googleClientId = v.trim());
  const gc = $("#sGcal"); if (gc) gc.onchange = () => { S.googleCalEnabled = gc.checked; persist("Saved"); if (gc.checked && !accessToken) connectGoogle(); render(); };
  bind("#sGids", v => S.googleCalendarIds = v.split(",").map(x => x.trim()).filter(Boolean));
  bind("#sFlex", v => S.flexCalendarIds = v.split(",").map(x => x.trim()).filter(Boolean));
  const cn = $("#sConnect"); if (cn) cn.onclick = connectGoogle;
  bind("#sIcs", v => S.outlookIcsUrl = v.trim());
  bind("#sProxy", v => S.corsProxy = v.trim());
  // Changing an address drops its cached geocode so it re-resolves (via TomTom).
  bind("#sHome", v => { S.homeAddress = v.trim(); if (typeof normAddr === "function") delete DATA.places[normAddr(v.trim())]; });
  bind("#sGym", v => { S.gymAddress = v.trim(); if (typeof normAddr === "function") delete DATA.places[normAddr(v.trim())]; });
  bind("#sMode", v => S.travelMode = v);
  bind("#sBuf", v => S.defaultTravelMin = parseInt(v, 10) || 15);
  // A new/changed TomTom key invalidates cached routes so they refetch with it.
  bind("#sTomKey", v => { S.tomtomKey = v.trim(); DATA.routeCache = {}; });
  bind("#sMapKey", v => S.mapsApiKey = v.trim());
  bind("#sWkUrl", v => S.workoutAppUrl = v.trim());
  bind("#sWake", v => S.wakeTime = v);
  bind("#sBed", v => S.bedTime = v);
  bind("#sNight", v => S.nightTime = v);
  const ex = $("#sExport"); if (ex) ex.onclick = () => {
    const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "day-backup-" + todayISO() + ".json"; a.click();
  };
  const rs = $("#sReset"); if (rs) rs.onclick = () => {
    if (!confirm("Restore home/gym, wake/bed, gym time, training days and travel prefs to your preset? Your calendar/Drive/TomTom credentials are kept.")) return;
    applyPreset(); persist("Preset restored"); render();
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
$("#sync").style.cursor = "pointer";
$("#sync").title = "Tap to connect / sync Google";
$("#sync").onclick = connectGoogle;
document.addEventListener("pointerdown", unlockAudio, true);
document.addEventListener("touchend", unlockAudio, true);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && timersActive()) acquireWake(); });

(function init() {
  loadLocal();
  normalizeData();
  if (typeof seedOlyDown === "function") seedOlyDown(); // hydrate workout state for the timeline
  render();
  // Resume a still-valid Google session so reopening the app stays signed in.
  const tok = loadToken();
  if (tok) { accessToken = tok; setSync("syncing…"); onConnected(); }
  else setSync(googleLinked() ? "reconnecting…" : "connect Google", googleLinked() ? "" : "warn");
  // Pre-init the GIS token client (so the first tap is instant) and, for a user
  // who has linked before but whose cached token has expired, silently refresh it.
  let tries = 0;
  const t = setInterval(() => {
    if (gisAvailable()) {
      initTokenClient();
      clearInterval(t);
      if (!accessToken && googleLinked()) trySilentConnect();
    } else if (++tries > 40) clearInterval(t);
  }, 250);
  // The boot attempt above is popup-blocked on iOS (GIS popups need a user
  // gesture). Retry on the next few taps — with a live Google session and prior
  // consent the popup closes itself, so this reads as staying signed in.
  let reauthTries = 0;
  document.addEventListener("pointerdown", () => {
    if (accessToken || !googleLinked() || !gisAvailable() || reauthTries >= 3) return;
    if (trySilentConnect()) reauthTries++;
  }, true);
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}
