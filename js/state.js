'use strict';
// ─── Day — Life Manager: state, persistence & Google Drive sync ───────────────
// Single source of truth. Device-first (localStorage), with optional Google Drive
// sync of one JSON file (drive.file scope — only ever sees files this app creates).

// Google OAuth. The same token client requests Drive (for sync) and Calendar
// (read-only) scopes. Paste your client id in Settings; this default is the one
// from the sister app and only works once its origin is whitelisted in the
// Google Cloud console (see SETUP.md).
const DEFAULT_CLIENT_ID = "";
const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.readonly";
const DRIVE_FILENAME = "day_lifemanager.json";
const CACHE_KEY = "day_cache_v1";

let accessToken = null; // current token (also cached below so reopening stays signed in)
let tokenClient = null; // GIS token client
let fileId = null;      // cached Drive file id for in-place PATCH
let silentMode = false; // true while re-authing in the background — suppresses the "cancelled" toast

// ─── Stay-signed-in token cache ───────────────────────────────────────────────
// Google access tokens last ~1 hour. We remember that the user linked Google
// (day_google_linked) and cache the live token with its expiry (day_google_tok)
// so reopening the app within the hour is instant, and after that we silently
// re-request a token (no tap) whenever a Google session is still available.
const TOKKEY = "day_google_tok";
function googleLinked() { try { return localStorage.getItem("day_google_linked") === "1"; } catch (e) { return false; } }
function setGoogleLinked(v) { try { v ? localStorage.setItem("day_google_linked", "1") : localStorage.removeItem("day_google_linked"); } catch (e) {} }
function saveToken(tok, expiresInSec) { try { localStorage.setItem(TOKKEY, JSON.stringify({ t: tok, exp: Date.now() + (expiresInSec || 3600) * 1000 })); } catch (e) {} }
function loadToken() { try { const o = JSON.parse(localStorage.getItem(TOKKEY)); if (o && o.t && o.exp && Date.now() < o.exp - 60000) return o.t; } catch (e) {} return null; }
function clearToken() { try { localStorage.removeItem(TOKKEY); } catch (e) {} }
function dropToken() { accessToken = null; clearToken(); } // a 401 means the token died — forget it
// Silently re-acquire a token (no UI) for a user who has linked Google before.
function trySilentConnect() {
  if (silentMode) return false; // an attempt is already in flight — don't double-fire
  if (!clientId() || !googleLinked()) return false;
  if (!initTokenClient()) return false;
  silentMode = true;
  setSync("reconnecting…");
  try { tokenClient.requestAccessToken({ prompt: "" }); return true; } catch (e) { silentMode = false; return false; }
}

// ─── Personal preset ──────────────────────────────────────────────────────────
// Jonathan's non-credential defaults — seeded on a fresh install, re-applied once
// via migration, and re-appliable any time from Settings → "Reset to my preset".
// Credentials (Google Client ID, Outlook .ics, TomTom key) are deliberately NOT
// here — they're entered once in Settings and kept out of the public repo.
const PRESET_SETTINGS = {
  homeAddress: "1094 Sans Souci Way",
  gymAddress: "Crunch Chamblee",
  wakeTime: "08:30",
  bedTime: "00:45",          // 12:45 AM (after midnight — the timeline rolls it over)
  nightTime: "20:00",        // nighttime routine usually starts 8:00 PM
  travelMode: "driving",
};
const PRESET_WORKOUT = {
  departTime: "15:00",       // leave the house for the gym ~3:00 PM
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], // all 7 — the program's own rest days decide
};
function applyPreset() {
  Object.assign(DATA.settings, PRESET_SETTINGS);
  // Clone days[] so toggling training days never mutates the PRESET_WORKOUT
  // constant (which would corrupt a later "Reset to my preset").
  Object.assign(DATA.workout, PRESET_WORKOUT, { days: PRESET_WORKOUT.days.slice() });
}

// ─── Data model ───────────────────────────────────────────────────────────────
let DATA = defaultData();
function defaultData() {
  return {
    version: 1,
    updated: null,
    migratedNoWorkBlocks: false, // one-time: drop website/content from morning routine
    presetApplied: false,        // one-time: seed Jonathan's personal preset onto an existing install
    regeocodedTomTom: false,     // one-time: clear stale geocodes/routes so TomTom re-resolves them
    // Routines (morning + nighttime) — same timed runner engine.
    routineConfig: { steps: [] },
    nightConfig: { steps: [] },
    routineLog: [],
    nightLog: [],
    // Workout duration mirror (no exercise logging — the sister app does that).
    workout: Object.assign({
      blockId: 1, weekInBlock: 0, cutting: false,
    }, PRESET_WORKOUT, { days: PRESET_WORKOUT.days.slice() }),
    settings: Object.assign({
      googleClientId: DEFAULT_CLIENT_ID,
      googleCalEnabled: false,
      googleCalendarIds: ["primary"],
      flexCalendarIds: [],          // calendars whose events are flexible work blocks
      outlookIcsUrl: "",
      corsProxy: "",                // optional, for Outlook ICS if it blocks CORS
      tomtomKey: "",                // free TomTom API key for live/predictive traffic (+ geocoding)
      mapsApiKey: "",               // optional Google key for live/traffic travel time
      defaultTravelMin: 15,         // fallback buffer when no route can be computed
      workoutAppUrl: "https://jonathandesta.github.io/oly-tracker/", // embedded in the Workout tab
    }, PRESET_SETTINGS),
    olyState: null, // synced snapshot of the embedded workout app: { data:<oly_state>, ts }
    olyDurations: null, // synced copy of the workout app's published week durations (oly_day_durations)
    places: {},     // normalizedAddress -> { lat, lon, label, ts }
    routeCache: {}, // "olat,olon|dlat,dlon|mode" -> { sec, ts }
    dayPlans: {},   // 'YYYY-MM-DD' -> { wakeTime?, bedTime?, workoutDepart?, workoutSkip?, tasks:[], removedEventIds:[] }
    calCache: {},   // 'YYYY-MM-DD' -> { google:[], outlook:[], ts }
  };
}

// Seed/repair missing keys so older Drive files gain new fields without data loss.
function normalizeData() {
  if (!DATA || typeof DATA !== "object") DATA = defaultData();
  const d = defaultData();
  for (const k of Object.keys(d)) {
    if (DATA[k] === undefined) DATA[k] = d[k];
  }
  // deep-fill settings & workout so newly added options appear
  DATA.settings = Object.assign({}, d.settings, DATA.settings || {});
  DATA.workout = Object.assign({}, d.workout, DATA.workout || {});

  // Routine configs: (re)seed when missing or when the seed version bumps.
  const rc = DATA.routineConfig;
  if (!rc || !Array.isArray(rc.steps) || !rc.steps.length || rc.v !== ROUTINE_VERSION) {
    DATA.routineConfig = {
      v: ROUTINE_VERSION,
      steps: ROUTINE_SEED.map(s => Object.assign({}, s)),
      transitionSec: (rc && typeof rc.transitionSec === "number") ? rc.transitionSec : 45,
    };
  }
  if (typeof DATA.routineConfig.transitionSec !== "number") DATA.routineConfig.transitionSec = 45;

  const nc = DATA.nightConfig;
  if (!nc || !Array.isArray(nc.steps) || !nc.steps.length || nc.v !== NIGHT_VERSION) {
    DATA.nightConfig = {
      v: NIGHT_VERSION,
      steps: NIGHT_SEED.map(s => Object.assign({}, s)),
      transitionSec: (nc && typeof nc.transitionSec === "number") ? nc.transitionSec : 45,
    };
  }
  if (typeof DATA.nightConfig.transitionSec !== "number") DATA.nightConfig.transitionSec = 45;

  // One-time: push the personal preset onto an existing install (non-credential
  // fields only — never touches Google Client ID / Outlook URL / TomTom key).
  if (!DATA.presetApplied) {
    applyPreset();
    DATA.presetApplied = true;
  }

  // One-time removal of the website/content blocks from the morning routine
  // (kept as edits to existing data so other custom tweaks survive).
  if (!DATA.migratedNoWorkBlocks) {
    if (DATA.routineConfig && Array.isArray(DATA.routineConfig.steps))
      DATA.routineConfig.steps = DATA.routineConfig.steps.filter(s => s.id !== "website" && s.id !== "content");
    DATA.migratedNoWorkBlocks = true;
  }

  // One-time: drop geocodes/routes cached under the old free-geocoder + heuristic
  // so addresses re-resolve through TomTom and travel times become real-traffic.
  if (!DATA.regeocodedTomTom) {
    DATA.places = {};
    DATA.routeCache = {};
    DATA.regeocodedTomTom = true;
  }

  if (!Array.isArray(DATA.routineLog)) DATA.routineLog = [];
  if (!Array.isArray(DATA.nightLog)) DATA.nightLog = [];
  if (!DATA.places || typeof DATA.places !== "object") DATA.places = {};
  if (!DATA.routeCache || typeof DATA.routeCache !== "object") DATA.routeCache = {};
  if (!DATA.dayPlans || typeof DATA.dayPlans !== "object") DATA.dayPlans = {};
  if (!DATA.calCache || typeof DATA.calCache !== "object") DATA.calCache = {};

  // Housekeeping: drop per-day plans/caches safely in the past so the synced
  // file doesn't grow forever (viewing any day auto-creates a dayPlan entry;
  // calendar events re-fetch on demand; routine history lives in the logs).
  const planCutoff = isoForOffset(-14), calCutoff = isoForOffset(-2);
  for (const k of Object.keys(DATA.dayPlans)) if (k < planCutoff) delete DATA.dayPlans[k];
  for (const k of Object.keys(DATA.calCache)) if (k < calCutoff) delete DATA.calCache[k];
}

// Per-day plan accessor (ad-hoc tasks, one-off overrides).
function dayPlan(dateISO) {
  if (!DATA.dayPlans[dateISO]) {
    DATA.dayPlans[dateISO] = { tasks: [], removedEventIds: [] };
  }
  const p = DATA.dayPlans[dateISO];
  if (!Array.isArray(p.tasks)) p.tasks = [];
  if (!Array.isArray(p.removedEventIds)) p.removedEventIds = [];
  return p;
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function saveLocal() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(DATA)); } catch (e) {}
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) DATA = JSON.parse(raw);
  } catch (e) {}
}

// Persist everywhere: device first (instant, never lost), then Drive if connected.
function persist(okMsg) {
  DATA.updated = new Date().toISOString();
  saveLocal();
  setSync("syncing…");
  saveDrive()
    .then(() => { setSync("synced ✓", "ok"); if (okMsg) toast(okMsg + " · synced"); })
    .catch(() => {
      setSync("saved on device", "warn"); if (okMsg) toast(okMsg + " · sync retry next save");
      // token may have expired mid-session — quietly refresh it for the next save
      if (!accessToken && googleLinked() && gisAvailable()) trySilentConnect();
    });
}

// ─── Google Identity Services ─────────────────────────────────────────────────
function clientId() { return (DATA.settings.googleClientId || DEFAULT_CLIENT_ID || "").trim(); }
function gisAvailable() { return !!(window.google && google.accounts && google.accounts.oauth2); }
function initTokenClient() {
  if (tokenClient || !gisAvailable() || !clientId()) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId(),
    scope: GOOGLE_SCOPES,
    callback: (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        saveToken(resp.access_token, resp.expires_in);
        setGoogleLinked(true); silentMode = false;
        onConnected();
      } else setSync("connect Google", "warn");
    },
    error_callback: () => { setSync("connect Google", "warn"); if (!silentMode) toast("Sign-in cancelled"); silentMode = false; },
  });
  return tokenClient;
}
function connectGoogle() {
  if (!clientId()) { toast("Add your Google Client ID in Settings"); return; }
  if (!initTokenClient()) { toast("Google library still loading — try again"); return; }
  setSync("connecting…");
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
}
async function onConnected() {
  setSync("syncing…");
  try {
    await findFile();
    const remote = await loadDrive();
    if (remote) reconcile(remote);
    else await saveDrive();
    setSync("synced ✓", "ok");
    if (typeof render === "function") render();
    if (DATA.settings.googleCalEnabled && typeof refreshCalendars === "function") refreshCalendars();
  } catch (e) {
    setSync("offline · using device", "warn");
    if (!accessToken && googleLinked() && gisAvailable()) trySilentConnect();
  }
}
function reconcile(remote) {
  const localU = DATA.updated ? Date.parse(DATA.updated) : 0;
  const remoteU = remote.updated ? Date.parse(remote.updated) : 0;
  if (remoteU >= localU) {
    DATA = remote; normalizeData(); saveLocal();
    // a newer remote may carry newer workout-app data → push it into shared storage
    if (typeof seedOlyDown === "function") seedOlyDown();
  } else saveDrive().catch(() => {});
}

// ─── Drive file CRUD ──────────────────────────────────────────────────────────
async function findFile() {
  if (!accessToken) throw new Error("no token");
  const q = "name='" + DRIVE_FILENAME + "' and trashed=false";
  const url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
    "&spaces=drive&fields=files(id,modifiedTime)";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  if (r.status === 401) { dropToken(); throw new Error("token expired"); }
  if (!r.ok) throw new Error("find " + r.status);
  const j = await r.json();
  fileId = (j.files && j.files.length) ? j.files[0].id : null;
  return fileId;
}
async function loadDrive() {
  if (!accessToken) throw new Error("no token");
  if (fileId === null) await findFile();
  if (!fileId) return null;
  const r = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media",
    { headers: { Authorization: "Bearer " + accessToken } });
  if (r.status === 401) { dropToken(); throw new Error("token expired"); }
  if (!r.ok) throw new Error("load " + r.status);
  return await r.json();
}
async function saveDrive() {
  saveLocal();
  if (!accessToken) throw new Error("no token");
  const body = JSON.stringify(DATA);
  if (!fileId) {
    const boundary = "day_" + Date.now();
    const multipart =
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({ name: DRIVE_FILENAME }) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      body + "\r\n" +
      "--" + boundary + "--";
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "multipart/related; boundary=" + boundary },
      body: multipart,
    });
    if (r.status === 401) { dropToken(); throw new Error("token expired"); }
    if (!r.ok) throw new Error("create " + r.status);
    const j = await r.json();
    fileId = j.id;
  } else {
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media", {
      method: "PATCH",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json; charset=UTF-8" },
      body: body,
    });
    if (r.status === 401) { dropToken(); throw new Error("token expired"); }
    if (!r.ok) throw new Error("save " + r.status);
  }
}

// ─── Tiny shared helpers ──────────────────────────────────────────────────────
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function todayDOW() { return DOW[new Date().getDay()]; }
function isoForOffset(days) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function tomorrowISO() { return isoForOffset(1); }
function dowForISO(iso) { return DOW[new Date(iso + "T00:00:00").getDay()]; }
function setSync(t, cls) { const e = $("#sync"); if (e) { e.textContent = t; e.className = "sync" + (cls ? " " + cls : ""); } }
function toast(t) { const e = $("#toast"); if (!e) return; e.textContent = t; e.classList.add("show"); setTimeout(() => e.classList.remove("show"), 2400); }
function fmtSec(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m + ":" + String(s % 60).padStart(2, "0"); }
function fmtSigned(s) { const neg = s < 0, a = Math.abs(Math.round(s)); return (neg ? "-" : "") + Math.floor(a / 60) + ":" + String(a % 60).padStart(2, "0"); }
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// "HH:MM" <-> minutes since midnight
function hmToMin(hm) { if (!hm || !/^\d{1,2}:\d{2}$/.test(hm)) return null; const [h, m] = hm.split(":").map(Number); return h * 60 + m; }
function minToHM(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
// 12-hour clock label, e.g. 195 -> "3:15 AM", 915 -> "3:15 PM"
function fmtClock(min) {
  min = Math.round(min);
  let day = "";
  if (min >= 1440) { day = " (+1)"; min -= 1440; }
  if (min < 0) { day = " (−1)"; min += 1440; }
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap + day;
}
