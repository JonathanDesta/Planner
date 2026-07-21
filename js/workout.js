'use strict';
// ─── Workout tab: the embedded Oly-Tracker app ────────────────────────────────
// The Workout tab embeds the real Oly-Tracker PWA in an iframe so opening it is
// like opening the workout app. Because both are served from the same origin
// (jonathandesta.github.io), they SHARE localStorage — so this app reads the live
// `oly_state` (block / week / cutting) directly to size the gym block on the
// master timeline. No duplicate settings: change your block in the workout app and
// the timeline follows automatically.

const DEFAULT_WORKOUT_URL = "https://jonathandesta.github.io/oly-tracker/";
function workoutAppUrl() { return (DATA.settings.workoutAppUrl || DEFAULT_WORKOUT_URL).trim(); }

const WORKOUT_BLOCKS = [
  { id: 0, name: "Week 0: Testing", weeks: 1 },
  { id: 1, name: "Block 1: Volume Accumulation", weeks: 4 },
  { id: 2, name: "Block 2: Intensification", weeks: 4 },
  { id: 3, name: "Block 3: Peaking / Realization", weeks: 3 },
  { id: 4, name: "Week 12: Deload", weeks: 1 },
];
// Fallback mirror of the Oly-Tracker program's session minutes (block id →
// weekday). The app itself publishes its real computed durations into shared
// storage (localStorage "oly_day_durations") on every save, and the timeline
// prefers those — this table is only used before the first publish reaches
// this device. Sunday is passive rest in EVERY block.
const WORKOUT_TOTALMIN = {
  0: { mon: 90, tue: 90, wed: 0, thu: 75, fri: 120, sat: 0, sun: 0 },
  1: { mon: 105, tue: 110, wed: 50, thu: 130, fri: 105, sat: 130, sun: 0 },
  2: { mon: 105, tue: 110, wed: 50, thu: 130, fri: 105, sat: 130, sun: 0 },
  3: { mon: 90, tue: 90, wed: 60, thu: 90, fri: 90, sat: 90, sun: 0 },
  4: { mon: 55, tue: 55, wed: 40, thu: 55, fri: 55, sat: 120, sun: 0 },
};
// No-sport weeks reinstate the plyo/interval work the program normally leaves
// to pickup sport — Blocks 1 & 2 sessions run longer on Mon/Wed/Thu.
const WORKOUT_TOTALMIN_NOSPORT = {
  1: { mon: 110, wed: 80, thu: 135 },
  2: { mon: 110, wed: 80, thu: 135 },
};
function workoutBlockName(id) { const b = WORKOUT_BLOCKS.find(b => b.id === id); return b ? b.name : "—"; }

// ─── Shared sync bridge for the embedded workout app ──────────────────────────
// The workout app saves to localStorage["oly_state"] (no cloud sync of its own).
// Because it shares this app's origin & storage, we ride Day's Drive sync:
//   • capture: when the embedded app writes oly_state, fold it into DATA.olyState
//     and push through Day's Drive file (debounced).
//   • seed: on another device, when Day pulls a newer copy, write it back into
//     localStorage BEFORE the iframe loads so the embedded app shows synced data.
function readLocalOly() { try { return JSON.parse(localStorage.getItem("oly_state")) || null; } catch (e) { return null; } }
let _lastOlyJSON = null, _olyPushTimer = null;
// The workout app also publishes its computed week of session durations (see
// its publishDayDurations) — fold that snapshot into synced state too, so the
// timeline on ANOTHER device sizes the gym block from the real program.
function captureOlyDurations() {
  let pub = null;
  try { pub = JSON.parse(localStorage.getItem("oly_day_durations")); } catch (e) {}
  if (!pub || !pub.min) return false;
  if (DATA.olyDurations && JSON.stringify(DATA.olyDurations) === JSON.stringify(pub)) return false;
  DATA.olyDurations = pub;
  return true;
}
function captureOlyState() {
  const durChanged = captureOlyDurations();
  const local = readLocalOly();
  const j = local ? JSON.stringify(local) : null;
  const cur = (DATA.olyState && DATA.olyState.data) ? JSON.stringify(DATA.olyState.data) : null;
  const stateChanged = !!(j && j !== cur && j !== _lastOlyJSON);
  if (!stateChanged && !durChanged) return; // nothing new / already handled
  if (stateChanged) {
    _lastOlyJSON = j;
    DATA.olyState = { data: local, ts: Date.now() };
  }
  saveLocal();
  // debounce the Drive push (the workout app may save several times in a row)
  clearTimeout(_olyPushTimer);
  setSync("syncing…");
  _olyPushTimer = setTimeout(() => {
    DATA.updated = new Date().toISOString(); saveLocal();
    saveDrive().then(() => setSync("synced ✓", "ok")).catch(() => setSync("saved on device", "warn"));
  }, 3500);
}
// ── Cross-container sync file ─────────────────────────────────────────────────
// The STANDALONE Oly-Tracker install (its own iOS storage container — invisible
// to us) publishes its state to Drive file "oly_sync.json" (same OAuth client,
// so drive.file scope lets us read it). Pull it on connect and adopt it when
// it's newer than our captured copy, so a week/block advanced in the standalone
// app lands here automatically. Day never writes this file — the workout app
// (standalone or embedded, which reuses our token) owns it.
let _olySyncFileId = null;
async function pullOlySync() {
  if (!accessToken) return;
  captureOlyState(); // fold any fresh embedded edits first so the ts comparison is fair
  if (_olySyncFileId === null) {
    const q = "name='oly_sync.json' and trashed=false";
    const r = await fetch("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) + "&spaces=drive&fields=files(id)",
      { headers: { Authorization: "Bearer " + accessToken } });
    if (!r.ok) return;
    const j = await r.json();
    _olySyncFileId = (j.files && j.files.length) ? j.files[0].id : "";
  }
  if (!_olySyncFileId) return;
  const r = await fetch("https://www.googleapis.com/drive/v3/files/" + _olySyncFileId + "?alt=media",
    { headers: { Authorization: "Bearer " + accessToken } });
  if (!r.ok) return;
  const remote = await r.json();
  if (!remote || !remote.ts || !remote.state) return;
  const curTs = (DATA.olyState && DATA.olyState.ts) || 0;
  if (remote.ts <= curTs) return;
  DATA.olyState = { data: remote.state, ts: remote.ts };
  if (remote.durations && remote.durations.min) DATA.olyDurations = remote.durations;
  _lastOlyJSON = JSON.stringify(remote.state); // don't re-capture the adoption
  seedOlyDown();
  persist("Workout data synced");
  if (typeof render === "function") render();
}

// Returns true if it changed localStorage (caller should reload the iframe).
function seedOlyDown() {
  // Seed the synced duration snapshot too (the embedded app republishes it on
  // load anyway; this covers the timeline before the Workout tab is opened).
  if (DATA.olyDurations && DATA.olyDurations.min) {
    try {
      const remoteD = JSON.stringify(DATA.olyDurations);
      if (localStorage.getItem("oly_day_durations") !== remoteD) localStorage.setItem("oly_day_durations", remoteD);
    } catch (e) {}
  }
  if (!DATA.olyState || !DATA.olyState.data) return false;
  const remoteJ = JSON.stringify(DATA.olyState.data);
  const local = readLocalOly();
  if (local && JSON.stringify(local) === remoteJ) return false; // already in sync
  try { localStorage.setItem("oly_state", remoteJ); } catch (e) {}
  _lastOlyJSON = remoteJ; // don't re-capture what we just seeded
  return true;
}

// Live block/week/cutting — prefer the embedded app's shared storage, then the
// synced snapshot, then our own DATA.workout fallback (different-origin dev).
function workoutBlockState() {
  const oly = readLocalOly() || (DATA.olyState && DATA.olyState.data) || null;
  if (oly && oly.program) return { blockId: oly.program.blockId | 0, weekInBlock: oly.program.weekInBlock || 0, cutting: !!oly.cutting, noSport: !!oly.noSport, src: "live" };
  const w = DATA.workout || {};
  return { blockId: w.blockId | 0, weekInBlock: w.weekInBlock || 0, cutting: !!w.cutting, noSport: false, src: "local" };
}

// The week of durations the workout app computed for itself — live shared
// storage first, then the Drive-synced snapshot (another device).
function readOlyDurations() {
  let pub = null;
  try { pub = JSON.parse(localStorage.getItem("oly_day_durations")); } catch (e) {}
  if (pub && pub.min) return pub;
  return (DATA.olyDurations && DATA.olyDurations.min) ? DATA.olyDurations : null;
}

// Today's (or a given date's) workout duration in minutes, 0 if a rest day.
function workoutDurationMin(dateISO) {
  const w = DATA.workout || {};
  const dow = DOW[new Date((dateISO || todayISO()) + "T00:00:00").getDay()];
  if (Array.isArray(w.days) && w.days.indexOf(dow) < 0) return 0; // your chosen training days
  const st = workoutBlockState();
  const key = dow.toLowerCase();
  // Prefer the durations the workout app computed for itself — but only while
  // they describe the same block/week/phase as its live state (a snapshot from
  // before a block change would reintroduce exactly the drift this prevents).
  const pub = readOlyDurations();
  if (pub && pub.blockId === st.blockId && (pub.weekInBlock || 0) === st.weekInBlock &&
      !!pub.cutting === st.cutting && !!pub.noSport === st.noSport) {
    return pub.min[key] || 0;
  }
  // Fallback: the mirror table above.
  const table = WORKOUT_TOTALMIN[st.blockId] || WORKOUT_TOTALMIN[1];
  const ns = st.noSport && WORKOUT_TOTALMIN_NOSPORT[st.blockId];
  let mins = (ns && ns[key]) || table[key] || 0;
  if (!mins) return 0;
  // Cutting trims session time ~15% — mirrors the app's own dayEstMin, which
  // scales training days only: Week 0 testing days and the deload Saturday
  // re-test have no training sections, so they keep their full time.
  if (st.cutting && st.blockId !== 0 && !(st.blockId === 4 && key === "sat")) mins = Math.round(mins * 0.85);
  return mins;
}
function workoutDepartMin(dateISO) {
  const p = DATA.dayPlans[dateISO];
  if (p && p.workoutDepart) return hmToMin(p.workoutDepart);
  return hmToMin((DATA.workout && DATA.workout.departTime) || "15:00");
}
function workoutSkippedFor(dateISO) { const p = DATA.dayPlans[dateISO]; return !!(p && p.workoutSkip); }

// ─── Workout view: summary strip + collapsible timing + embedded app ──────────
function workoutView() {
  seedOlyDown(); // ensure shared storage holds the synced copy before the iframe loads
  const w = DATA.workout;
  const st = workoutBlockState();
  const todayMin = workoutDurationMin(todayISO());
  const depart = workoutDepartMin(todayISO());
  const skipped = workoutSkippedFor(todayISO());

  let h = `<div class="wk-summary">
      <div class="wk-pill"><b>${todayMin ? todayMin + " min" : "rest"}</b><span>today</span></div>
      <div class="wk-pill"><b>${todayMin ? fmtClock(depart) : "—"}</b><span>leave by</span></div>
      <div class="wk-pill"><b>${workoutBlockName(st.blockId).split(":")[0]}</b><span>${st.cutting ? "cutting" : "bulk"}</span></div>
      <a class="wk-open" href="${escapeAttr(workoutAppUrl())}" target="_blank" rel="noopener">↗ full</a>
    </div>`;

  h += `<details class="wk-cfg"><summary>Timeline settings (when you train)</summary>
    <div class="frow"><label>Default gym departure</label><input id="wkDepart" type="time" class="sel" value="${(w.departTime || "15:00")}"></div>
    <div class="frow"><label>Skip the gym today</label><input type="checkbox" id="wkSkip" ${skipped ? "checked" : ""}></div>
    <div class="frow"><label>Training days</label>
      <div class="daypick" id="wkDays">${DOW.map(d => `<button class="daybtn ${(w.days || []).indexOf(d) >= 0 ? "on" : ""}" data-d="${d}">${d}</button>`).join("")}</div></div>
    <div class="hint">Block, week, phase and all logging live in the embedded app below — change them there and the timeline follows. Its data is backed up and synced through Day's Google Drive ${DATA.olyState ? "✓ last saved " + new Date(DATA.olyState.ts).toLocaleString() : "(connect Google to enable)"}.</div>
  </details>`;

  h += `<iframe class="workframe" id="workframe" src="${escapeAttr(workoutAppUrl())}"
      allow="autoplay; screen-wake-lock; clipboard-write; fullscreen"
      referrerpolicy="no-referrer-when-downgrade"></iframe>`;
  return h;
}
function bindWorkout() {
  const w = DATA.workout;
  const dp = $("#wkDepart"); if (dp) dp.onchange = () => { w.departTime = dp.value || "15:00"; persist("Departure set"); };
  const sk = $("#wkSkip"); if (sk) sk.onchange = () => { dayPlan(todayISO()).workoutSkip = sk.checked; persist(sk.checked ? "Gym skipped today" : "Gym back on"); };
  $$("#wkDays .daybtn").forEach(b => b.onclick = () => {
    const d = b.dataset.d; w.days = w.days || [];
    const i = w.days.indexOf(d); if (i >= 0) w.days.splice(i, 1); else w.days.push(d);
    persist("Days updated"); render();
  });
}

// Capture the embedded app's saves and fold them into Day's synced state.
// A same-origin iframe writing localStorage fires 'storage' in this parent frame.
window.addEventListener("storage", (e) => { if (e.key === "oly_state" || e.key === "oly_day_durations") captureOlyState(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") captureOlyState(); });
// Safety net: while the embedded app is in use, the cross-frame storage event can
// be unreliable on iOS — poll cheaply (captureOlyState no-ops when unchanged).
setInterval(() => { if (CUR === "Workout" && document.visibilityState === "visible") captureOlyState(); }, 5000);
