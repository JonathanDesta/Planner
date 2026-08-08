'use strict';
// ─── Morning & Nighttime routines: seeds + timed-step runner ──────────────────
// Each routine is an ordered list of steps with a hard per-step time cap. The
// runner shows the active step large with a countdown, a master ahead/behind
// pace clock, and Done/Skip. Ported from the sister Routines app.

const ROUTINE_VERSION = 10; // bump to re-seed default morning steps on existing installs
const NIGHT_VERSION = 2;   // bump to re-seed default night steps

// Day-aware morning order. Haircare is a two-shower flow (Mon + Thu) around the
// masque sit; both are shave days, so the cleanse is in Shower 1 and the face
// shave fills the masque sit; the everyday cold shower runs only on
// non-haircare days. `detail` shows amounts/technique.
const ROUTINE_SEED = [
  { id: "bed", name: "Out of bed + make bed", targetSec: 120, days: "daily" },
  { id: "bathroom", name: "Bathroom — pee + poop", targetSec: 600, days: "daily" },
  { id: "oral", name: "Oral hygiene (brush, mouthwash, water floss, tongue scrape)", targetSec: 330, days: "daily" },
  { id: "shower1", name: "Shower 1 — facial cleanse + shampoo + apply masque", targetSec: 240, days: ["Mon", "Thu"], parallel: true, masqueSec: 600, bgName: "Masque sit", detail: "Cleanse face first (you shave right after). Shampoo: nickel-sized, massaged into scalp. Masque: 3 palmfuls, combed through." },
  { id: "bodyshave", name: "Shave armpits + pubes", targetSec: 600, days: ["Sun"], detail: "Before the shower so you rinse off right after." },
  { id: "shower", name: "Morning shower: cleanse + 3:00 cold + rinse", targetSec: 360, days: ["Tue", "Wed", "Fri", "Sat", "Sun"], cold: true, coldSec: 180 },
  { id: "faceshave", name: "Face shave — 2 passes (WTG then ATG)", targetSec: 720, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], detail: "Every day except Sun. On hair days this fills the masque sit." },
  { id: "skincare_nh", name: "AM skincare: cleanser → Vit C → hyaluronic acid → sunscreen", targetSec: 240, days: ["Tue", "Wed", "Fri", "Sat", "Sun"] },
  { id: "shower2", name: "Shower 2 — rinse masque + 3:00 cold", targetSec: 300, days: ["Mon", "Thu"], cold: true, coldSec: 180, detail: "Rinse masque out fully, then 3:00 cold (face already cleansed in Shower 1)." },
  { id: "leavein", name: "Leave-in conditioner — comb through", targetSec: 90, days: ["Mon", "Thu"], detail: "1 palmful, rubbed between palms, raked through, then combed." },
  { id: "jojoba", name: "Jojoba oil — rake through", targetSec: 60, days: ["Mon", "Thu"], detail: "3 drops, rubbed between palms, raked through." },
  { id: "stylinggel", name: "Styling gel — rake through", targetSec: 90, days: ["Mon", "Thu"], detail: "1 palmful, raked through." },
  { id: "curlsponge", name: "Curl sponge — 5 min", targetSec: 300, days: ["Mon", "Thu"], detail: "Work in small circles all over, ~5 min." },
  { id: "skincare_h", name: "AM skincare: cleanser → Vit C → hyaluronic acid → sunscreen", targetSec: 240, days: ["Mon", "Thu"] },
  { id: "lotion", name: "Apply lotion", targetSec: 120, days: "daily" },
  { id: "dressed", name: "Get dressed", targetSec: 180, days: "daily" },
  { id: "eyebrowgel", name: "Apply eyebrow gel", targetSec: 60, days: "daily" },
  { id: "breakfast", name: "Breakfast: cook + eat (3 eggs, 2 toast)", targetSec: 900, days: "daily" },
  { id: "read", name: "Read + take notes — 2 chapters (The Road to Serfdom, then Capitalism and Freedom)", targetSec: 5400, days: "daily", soft: true },
  { id: "clipnails", name: "Clip nails", targetSec: 300, days: ["Sun"] },
  { id: "vacuum", name: "Vacuum", targetSec: 600, days: ["Sun"] },
  { id: "cleanears", name: "Clean out ears", targetSec: 180, days: ["Sun"] },
];

const NIGHT_SEED = [
  { id: "bacopa", name: "Take bacopa monnieri", targetSec: 60, days: "daily" },
  { id: "makeshake", name: "Make protein shake (glycine + creatine)", targetSec: 180, days: "daily", detail: "1 scoop protein + glycine + creatine, shake/blend. Made now so it's ready after the shower." },
  { id: "nightshower", name: "Full scrubbing shower + facial cleanse", targetSec: 600, days: "daily", detail: "Scrub down the whole body, then cleanse the face." },
  { id: "nightlotion", name: "Apply lotion", targetSec: 120, days: "daily" },
  { id: "pmskincare", name: "PM skincare: Differin + hyaluronic acid + moisturizer", targetSec: 300, days: "daily", detail: "Differin gel: pea-sized on dry skin. Then hyaluronic acid, then PM facial moisturizer." },
  { id: "drinkshake", name: "Drink protein shake", targetSec: 180, days: "daily" },
  { id: "magnesium", name: "Take magnesium", targetSec: 60, days: "daily" },
  { id: "nightoral", name: "Oral hygiene (brush, mouthwash, water floss, tongue scrape)", targetSec: 300, days: "daily" },
  { id: "retainer", name: "Put in retainer", targetSec: 60, days: "daily" },
];

// ─── Routine helpers ──────────────────────────────────────────────────────────
function stepRunsOn(s, dow) { return s.days === "daily" || (Array.isArray(s.days) && s.days.indexOf(dow) >= 0); }
function parseDays(str) {
  str = (str || "").trim();
  if (!str || /^daily$/i.test(str)) return "daily";
  const set = str.split(/[,\s]+/).map(d => d.slice(0, 1).toUpperCase() + d.slice(1, 3).toLowerCase()).filter(d => DOW.indexOf(d) >= 0);
  return set.length ? set : "daily";
}
function daysToStr(d) { return d === "daily" ? "daily" : (Array.isArray(d) ? d.join(", ") : "daily"); }

// Active-routine accessors — the runner serves both Morning and Nighttime tabs.
function RCFG() { return CUR === "Night" ? DATA.nightConfig : DATA.routineConfig; }
function RLOG() { return CUR === "Night" ? DATA.nightLog : DATA.routineLog; }
function setRLOG(v) { if (CUR === "Night") DATA.nightLog = v; else DATA.routineLog = v; }
function RKEY() { return CUR === "Night" ? "day_night_run_v1" : "day_morning_run_v1"; }
function RLABEL() { return CUR === "Night" ? "night routine" : "morning routine"; }
function RVERB() { return CUR === "Night" ? "Nighttime" : "Morning"; }
function isRoutineTab(t) { return t === "Morning" || t === "Night"; }
function transSec(cfg) { cfg = cfg || RCFG(); return (cfg && cfg.transitionSec) || 0; }
function routineSteps(cfg, dow) {
  cfg = cfg || RCFG();
  dow = dow || todayDOW();
  return (cfg.steps || []).filter(s => stepRunsOn(s, dow));
}
// Steps the morning routine drops for a given date (per-day "amputations").
function morningDropFor(dateISO) { const p = DATA.dayPlans[dateISO]; return (p && p.dropSteps) || []; }
function applyDrop(steps, drop) { return (drop && drop.length) ? steps.filter(s => drop.indexOf(s.id) < 0) : steps; }
function todaySteps() {
  let steps = routineSteps(RCFG(), todayDOW());
  if (CUR !== "Night") steps = applyDrop(steps, morningDropFor(todayISO())); // honor today's morning drops
  return steps;
}
// Total seconds a routine will take (caps + transition buffer) — used by the timeline.
// `drop` (optional) = step ids removed that day (e.g. reading moved to its own block).
function routineBudgetSec(cfg, dow, drop) {
  const steps = applyDrop(routineSteps(cfg, dow), drop);
  return steps.reduce((s, x) => s + x.targetSec, 0) + transSec(cfg) * steps.length;
}

// ─── Alarm / wake-lock / notify (built for iOS limits) ────────────────────────
// iOS has no web vibration and freezes timers when backgrounded. Reliable path:
// a generated sound on a media-channel <audio> (sounds on silent), unlocked on
// first tap, plus a Screen Wake Lock so the screen stays on mid-timer.
let alarmEl = null, audioUnlocked = false, audioCtx = null, wakeLock = null, askedNotif = false;
// Playing any audio normally claims iOS's exclusive "playback" session, which
// pauses Apple Music when the alarm fires. 'ambient' mixes with other apps'
// audio instead. Trade-off: ambient audio follows the ringer/silent switch,
// so with the switch on silent the beep is muted (vibration still fires).
function setAudioMixing() {
  try { if ("audioSession" in navigator) navigator.audioSession.type = "ambient"; } catch (e) {}
}
setAudioMixing();
function makeAlarmURI() {
  const sr = 8000, dur = 2.0, n = Math.floor(sr * dur), buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); ws(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr, k = Math.floor(t / 0.32), lt = t - k * 0.32; let s = 0;
    if (lt < 0.2 && k < 6) { const f = k % 2 ? 988 : 784, env = Math.min(1, lt / 0.008) * Math.min(1, (0.2 - lt) / 0.02); s = Math.sin(2 * Math.PI * f * t) * 0.75 * env; }
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }
  let bin = "", by = new Uint8Array(buf); for (let i = 0; i < by.length; i++) bin += String.fromCharCode(by[i]);
  return "data:audio/wav;base64," + btoa(bin);
}
function initAlarm() { if (!alarmEl) { alarmEl = new Audio(); alarmEl.src = makeAlarmURI(); alarmEl.preload = "auto"; } }
function unlockAudio() {
  setAudioMixing();
  initAlarm(); if (audioUnlocked) return; alarmEl.muted = true;
  const p = alarmEl.play();
  const done = () => { try { alarmEl.pause(); alarmEl.currentTime = 0; } catch (e) {} alarmEl.muted = false; audioUnlocked = true; };
  if (p && p.then) p.then(done).catch(() => { alarmEl.muted = false; }); else done();
  try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch (e) {}
}
function notify(msg) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification("⏱ " + (msg || "Time!"), { body: "Timer complete — next up.", tag: "day-timer", renotify: true });
      setTimeout(() => { try { n.close(); } catch (e) {} }, 6000);
    }
  } catch (e) {}
}
function maybeAskNotif() { if (askedNotif) return; askedNotif = true; try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {}); } catch (e) {} }
async function acquireWake() { try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch (e) {} }
function releaseWake() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
function timersActive() { return routineInt != null; }
function updateWake() { if (timersActive()) acquireWake(); else releaseWake(); }
function beep(msg) {
  setAudioMixing();
  try { initAlarm(); alarmEl.muted = false; alarmEl.currentTime = 0; const p = alarmEl.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(.0001, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(.4, audioCtx.currentTime + .02);
    g.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + .6); o.start(); o.stop(audioCtx.currentTime + .62);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 300]);
  notify(msg);
}

// ─── Runner state ─────────────────────────────────────────────────────────────
let RUN = null;       // in-progress run (mirrored to localStorage so reloads resume)
let runTab = null;    // which routine tab RUN belongs to
let routineInt = null;
let editMode = false;

function saveRun() { if (RUN) localStorage.setItem(RKEY(), JSON.stringify(RUN)); else localStorage.removeItem(RKEY()); }
function loadRun() { try { const r = JSON.parse(localStorage.getItem(RKEY())); if (r && r.date === todayISO()) return r; } catch (e) {} return null; }
function last7Avg() {
  const log = (RLOG() || []).slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
  if (!log.length) return null;
  return Math.round(log.reduce((s, x) => s + x.totalSec, 0) / log.length);
}

// ─── Routine views ────────────────────────────────────────────────────────────
function routineView() {
  if (runTab !== CUR) { RUN = null; runTab = CUR; }
  if (!RUN) RUN = loadRun();
  if (RUN && RUN.cur < RUN.steps.length) return routineRunningView();
  if (RUN && RUN.cur >= RUN.steps.length) return routineFinishView();
  return routineStartView();
}
function routineStartView() {
  const steps = RCFG().steps;
  const today = todaySteps();
  const tr = transSec();
  const budget = today.reduce((s, x) => s + x.targetSec, 0) + tr * today.length;
  const avg = last7Avg();
  const when = CUR === "Night" ? "Tonight" : "Today is " + todayDOW();
  let h = `<div class="daysub">${when} · ${today.length} step${today.length !== 1 ? "s" : ""} · budget ~${Math.round(budget / 60)} min${tr ? ` <span class="muted">(incl. ${tr}s/step transition)</span>` : ""}</div>`;
  // Night-before look-ahead lives at the top of the Night start screen.
  if (CUR === "Night" && typeof lookAheadHTML === "function") h += lookAheadHTML(true);
  const budgetLbl = (CUR === "Night" ? "Tonight's" : "Today's") + " budget";
  h += `<div class="kpis">
    <div class="kpi"><div class="v">~${Math.round(budget / 60)}m</div><div class="l">${budgetLbl}</div></div>
    <div class="kpi"><div class="v">${avg ? fmtSec(avg) : "–"}</div><div class="l">Last-7 avg</div></div>
    <div class="kpi"><div class="v">${(RLOG() || []).length}</div><div class="l">Logged</div></div></div>`;
  if (editMode) return h + routineEditorView(steps);
  h += `<div class="card"><div class="cardhd"><b>${CUR === "Night" ? "Tonight's" : "Today's"} steps</b><button class="chipbtn" id="editToggle">Edit steps</button></div>`;
  if (!today.length) h += `<div class="muted">No steps yet. Tap "Edit steps" to add some.</div>`;
  today.forEach((s, i) => {
    h += `<div class="mstep"><div><div>${i + 1}. ${escapeHtml(s.name)}${s.parallel ? ' <span class="tagp">parallel</span>' : ''}${s.cold ? ' <span class="tagc">cold</span>' : ''}${s.soft ? ' <span class="tags">soft</span>' : ''}</div>${s.detail ? `<div class="mstep-d">${escapeHtml(s.detail)}</div>` : ""}</div><div class="mstep-t">${fmtSec(s.targetSec)}</div></div>`;
  });
  h += `</div>`;
  if (today.length) h += `<div class="card mstart"><button class="btn primary" id="startRoutine">Start ${RLABEL()} ▸</button></div>`;
  return h;
}
function routineEditorView(steps) {
  let h = `<div class="card"><div class="cardhd"><b>Edit steps</b><button class="chipbtn" id="editToggle">Done</button></div>
    <div class="edrow" style="margin:0 0 10px"><label>transition between steps</label>
      <input id="edTrans" type="number" inputmode="numeric" value="${transSec()}" style="width:60px"><span>sec</span></div>`;
  steps.forEach((s, i) => {
    h += `<div class="edstep">
      <input class="ed-name" data-i="${i}" value="${escapeAttr(s.name)}" placeholder="step name">
      <div class="edrow">
       <label>min</label><input class="ed-min" type="number" inputmode="decimal" data-i="${i}" value="${+(s.targetSec / 60).toFixed(2)}" style="width:62px">
       <label>days</label><input class="ed-days" data-i="${i}" value="${escapeAttr(daysToStr(s.days))}" style="width:130px" placeholder="daily or Mon,Wed">
       <label class="edchk"><input type="checkbox" class="ed-par" data-i="${i}" ${s.parallel ? "checked" : ""}>parallel</label>
       <label class="edchk"><input type="checkbox" class="ed-soft" data-i="${i}" ${s.soft ? "checked" : ""}>soft</label>
      </div>
      <div class="edrow">
       <button class="chipbtn ed-up" data-i="${i}">↑</button>
       <button class="chipbtn ed-dn" data-i="${i}">↓</button>
       <button class="chipbtn ed-del" data-i="${i}" style="color:var(--red)">Delete</button>
      </div></div>`;
  });
  h += `<div class="addrow" style="margin-top:8px">
    <button class="btn ghost" id="edAdd">+ Add step</button>
    <button class="btn primary" id="edSave" style="flex:0 0 auto">Save steps ▸ sync</button></div></div>`;
  return h;
}
function routineRunningView() {
  const s = RUN.steps[RUN.cur];
  const next = RUN.steps.slice(RUN.cur + 1).find(x => x.status === "pending");
  const totalTarget = RUN.steps.reduce((a, x) => a + x.targetSec, 0) + transSec() * RUN.steps.length;
  let h = `<div class="mclock-card">
    <div class="mclock-top">
      <div><div class="mclock" id="mClock">0:00</div><div class="mclock-sub">of ~${Math.round(totalTarget / 60)}m budget</div></div>
      <div class="mpace" id="mPace">on pace</div></div>
    <button class="chipbtn light" id="endRoutine" style="margin-top:10px">End &amp; log ${RLABEL()}</button></div>`;
  h += `<div class="card mstep-active">
    <div class="exnote">step ${RUN.cur + 1} of ${RUN.steps.length}${s.soft ? " · wind-down (soft target)" : ""}</div>
    <div class="mstep-name">${escapeHtml(s.name)}</div>
    <div class="mstep-clock ${s.soft ? "soft" : ""}" id="stepClock">${fmtSigned(s.targetSec)}</div>
    <div class="mstep-target">target ${fmtSec(s.targetSec)}</div>
    ${s.detail ? `<div class="mstep-detail">${escapeHtml(s.detail)}</div>` : ""}`;
  if (s.cold) {
    if (!RUN.cold) h += `<div class="subtimer"><div class="sub-stages">cleanse → <b>3:00 cold</b> → rinse</div>
      <button class="btn primary sm" id="coldStart">Start 3:00 cold ❄</button></div>`;
    else h += `<div class="subtimer cold"><div class="sub-stages">❄ cold exposure — <span id="coldStage">${RUN.cold.done ? "rinse now" : "hold"}</span></div>
      <div class="mstep-clock" id="coldClock">${fmtSec(Math.max(0, Math.round((RUN.cold.endTs - Date.now()) / 1000)))}</div></div>`;
  }
  h += `<div class="mbtns">`;
  if (s.parallel) h += `<button class="btn ghost" id="stepParallel">Start masque sit ▸ continue meanwhile</button>`;
  h += `<button class="btn ghost sm" id="stepSkip">Skip</button><button class="btn primary" id="stepDone">Done ▸ next</button></div></div>`;
  if (next) h += `<div class="card mnext"><span class="muted">next:</span> ${escapeHtml(next.name)} · <span class="muted">${fmtSec(next.targetSec)}</span></div>`;
  h += `<div class="card"><div class="mprog">`;
  RUN.steps.forEach((x, i) => {
    const st = x.status; const ic = st === "done" ? "✓" : st === "skipped" ? "–" : i === RUN.cur ? "▶" : "·";
    h += `<div class="mprogrow ${st}"><span class="mpi">${ic}</span> ${escapeHtml(x.name)}<span class="muted" style="margin-left:auto">${x.actualSec != null ? fmtSec(x.actualSec) : fmtSec(x.targetSec)}</span></div>`;
  });
  h += `</div></div>`;
  return h;
}
function routineFinishView() {
  const totalSec = Math.round((Date.now() - RUN.startTs) / 1000);
  const totalTarget = RUN.steps.reduce((a, x) => a + x.targetSec, 0);
  let h = `<div class="card mstep-active">
    <div class="mstep-name">${RVERB()} complete 🎉</div>
    <div class="mclock" style="color:var(--ink);margin:6px 0">${fmtSec(totalSec)}</div>
    <div class="muted">vs ~${Math.round(totalTarget / 60)}m budget</div>
    <div class="mprog" style="margin-top:12px;text-align:left">`;
  RUN.steps.forEach(x => { h += `<div class="mprogrow ${x.status}"><span class="mpi">${x.status === "skipped" ? "–" : "✓"}</span> ${escapeHtml(x.name)}<span class="muted" style="margin-left:auto">${x.actualSec != null ? fmtSec(x.actualSec) : "–"}</span></div>`; });
  h += `</div><button class="btn primary" id="finishLog" style="margin-top:14px;width:100%">Finish &amp; log ▸ sync</button></div>`;
  return h;
}

// ─── Runner actions ───────────────────────────────────────────────────────────
function startRoutine() {
  const steps = todaySteps().map(s => ({
    id: s.id, name: s.name, targetSec: s.targetSec, parallel: !!s.parallel,
    cold: !!s.cold, coldSec: s.coldSec || 180, masqueSec: s.masqueSec || 600, bgName: s.bgName || s.name,
    soft: !!s.soft, detail: s.detail || "", status: "pending", startTs: null, actualSec: null, beeped: false,
  }));
  if (!steps.length) { toast("No steps for today"); return; }
  RUN = { date: todayISO(), startTs: Date.now(), cur: 0, steps, bg: [], cold: null };
  steps[0].status = "active"; steps[0].startTs = Date.now();
  saveRun(); render();
}
function finishStep(status) {
  if (!RUN) return; const s = RUN.steps[RUN.cur]; if (!s) return;
  s.actualSec = Math.round((Date.now() - (s.startTs || Date.now())) / 1000);
  s.status = status; RUN.cold = null; advanceStep();
}
function startParallel() {
  if (!RUN) return; const s = RUN.steps[RUN.cur]; if (!s) return;
  s.actualSec = Math.round((Date.now() - (s.startTs || Date.now())) / 1000); s.status = "done";
  RUN.bg.push({ name: s.bgName || s.name, endTs: Date.now() + (s.masqueSec || 600) * 1000, done: false, dismissed: false });
  advanceStep();
}
function startCold() { if (!RUN) return; const s = RUN.steps[RUN.cur]; RUN.cold = { endTs: Date.now() + (s.coldSec || 180) * 1000, done: false }; saveRun(); render(); }
function advanceStep() {
  let n = RUN.cur + 1;
  while (n < RUN.steps.length && (RUN.steps[n].status === "done" || RUN.steps[n].status === "skipped")) n++;
  if (n >= RUN.steps.length) { RUN.cur = RUN.steps.length; saveRun(); render(); return; }
  RUN.cur = n; RUN.steps[n].status = "active"; RUN.steps[n].startTs = Date.now(); RUN.steps[n].beeped = false;
  saveRun(); render();
}
function endRoutineEarly() {
  if (!RUN) return;
  const pending = RUN.steps.filter(s => s.status === "pending" || s.status === "active").length;
  if (pending && !confirm("End the " + RLABEL() + " now and log what you've completed? " + pending + " step" + (pending !== 1 ? "s" : "") + " still pending.")) return;
  finalizeRoutine();
}
function finalizeRoutine() {
  if (!RUN) return;
  const perStep = {}; RUN.steps.forEach(s => { if (s.actualSec != null) perStep[s.id] = s.actualSec; });
  const totalSec = Math.round((Date.now() - RUN.startTs) / 1000);
  setRLOG((RLOG() || []).filter(e => e.date !== RUN.date));
  RLOG().push({ date: RUN.date, totalSec, perStep });
  RUN = null; saveRun(); if (routineInt) { clearInterval(routineInt); routineInt = null; } updateWake();
  persist(RVERB() + " logged");
  render();
}
function routineTick() {
  if (!RUN || RUN.cur >= RUN.steps.length) return;
  const now = Date.now();
  const elapsed = Math.round((now - RUN.startTs) / 1000);
  const mc = $("#mClock"); if (mc) mc.textContent = fmtSec(elapsed);
  const s = RUN.steps[RUN.cur];
  const sElapsed = Math.round((now - s.startTs) / 1000);
  const left = s.targetSec - sElapsed;
  const sc = $("#stepClock"); if (sc) { sc.textContent = fmtSigned(left); sc.classList.toggle("over", left < 0 && !s.soft); }
  if (left <= 0 && !s.beeped) { s.beeped = true; beep(); saveRun(); }
  const tr = transSec();
  let allowed = 0; RUN.steps.forEach(x => { if (x.status === "done" || x.status === "skipped") allowed += x.targetSec + tr; });
  allowed += Math.min(sElapsed, s.targetSec);
  const pace = elapsed - allowed;
  const pe = $("#mPace");
  if (pe) {
    if (pace > 5) { pe.textContent = "▼ " + fmtSec(pace) + " behind"; pe.className = "mpace behind"; }
    else if (pace < -5) { pe.textContent = "▲ " + fmtSec(-pace) + " ahead"; pe.className = "mpace ahead"; }
    else { pe.textContent = "on pace"; pe.className = "mpace"; }
  }
  if (RUN.cold) {
    const cl = Math.round((RUN.cold.endTs - now) / 1000); const ce = $("#coldClock"); if (ce) ce.textContent = fmtSec(Math.max(0, cl));
    if (cl <= 0 && !RUN.cold.done) { RUN.cold.done = true; beep(); saveRun(); const cg = $("#coldStage"); if (cg) cg.textContent = "rinse now"; }
  }
  let changed = false; RUN.bg.forEach(t => { if (!t.done && now >= t.endTs) { t.done = true; changed = true; beep(); } });
  if (changed) saveRun();
  renderBgChip();
}
function renderBgChip() {
  const el = $("#bgbar"); if (!el) return;
  const live = RUN && RUN.bg ? RUN.bg.filter(t => !t.dismissed) : [];
  if (!live.length) { el.classList.remove("show"); el.innerHTML = ""; return; }
  const now = Date.now(); el.classList.add("show");
  el.innerHTML = RUN.bg.map((t, i) => {
    if (t.dismissed) return "";
    const left = Math.round((t.endTs - now) / 1000);
    return `<div class="bgrow ${t.done ? "done" : ""}"><div class="bgc">${t.done ? "✓" : fmtSec(Math.max(0, left))}</div>
      <div class="bgl">${t.done ? escapeHtml(t.name) + " done — rinse" : escapeHtml(t.name)}</div>
      <button class="bgx" data-bg="${i}">×</button></div>`;
  }).join("");
  $$(".bgx").forEach(b => b.onclick = () => { RUN.bg[+b.dataset.bg].dismissed = true; saveRun(); renderBgChip(); });
}
function bindRoutine() {
  if (routineInt) { clearInterval(routineInt); routineInt = null; }
  if (CUR === "Night" && typeof bindLookAhead === "function") bindLookAhead();
  const steps = RCFG().steps;
  const sr = $("#startRoutine"); if (sr) sr.onclick = startRoutine;
  const et = $("#editToggle"); if (et) et.onclick = () => { editMode = !editMode; render(); };
  $$(".ed-name").forEach(el => el.onchange = () => { steps[+el.dataset.i].name = el.value || "Untitled"; });
  $$(".ed-min").forEach(el => el.onchange = () => { const m = parseFloat(el.value); if (!isNaN(m)) steps[+el.dataset.i].targetSec = Math.max(5, Math.round(m * 60)); });
  $$(".ed-days").forEach(el => el.onchange = () => { steps[+el.dataset.i].days = parseDays(el.value); });
  $$(".ed-par").forEach(el => el.onchange = () => { steps[+el.dataset.i].parallel = el.checked; });
  $$(".ed-soft").forEach(el => el.onchange = () => { steps[+el.dataset.i].soft = el.checked; });
  $$(".ed-up").forEach(b => b.onclick = () => { const i = +b.dataset.i; if (i > 0) { const t = steps[i - 1]; steps[i - 1] = steps[i]; steps[i] = t; render(); } });
  $$(".ed-dn").forEach(b => b.onclick = () => { const i = +b.dataset.i; if (i < steps.length - 1) { const t = steps[i + 1]; steps[i + 1] = steps[i]; steps[i] = t; render(); } });
  $$(".ed-del").forEach(b => b.onclick = () => { steps.splice(+b.dataset.i, 1); render(); });
  const tr = $("#edTrans"); if (tr) tr.onchange = () => { const v = parseInt(tr.value, 10); if (!isNaN(v)) RCFG().transitionSec = Math.max(0, v); };
  const ea = $("#edAdd"); if (ea) ea.onclick = () => { steps.push({ id: "s" + Date.now(), name: "New step", targetSec: 300, days: "daily" }); render(); };
  const es = $("#edSave"); if (es) es.onclick = () => persist("Steps saved");
  const db = $("#stepDone"); if (db) db.onclick = () => finishStep("done");
  const kb = $("#stepSkip"); if (kb) kb.onclick = () => finishStep("skipped");
  const pb = $("#stepParallel"); if (pb) pb.onclick = startParallel;
  const cb = $("#coldStart"); if (cb) cb.onclick = startCold;
  const em = $("#endRoutine"); if (em) em.onclick = endRoutineEarly;
  const fl = $("#finishLog"); if (fl) fl.onclick = finalizeRoutine;
  renderBgChip();
  if (RUN && RUN.cur < RUN.steps.length) { maybeAskNotif(); routineTick(); routineInt = setInterval(routineTick, 250); }
  updateWake();
}
