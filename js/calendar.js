'use strict';
// ─── Calendar integration ─────────────────────────────────────────────────────
// Google Calendar (read-only) via the same GSI token used for Drive, plus an
// Outlook/M365 published .ics feed (fetched + parsed locally, with optional CORS
// proxy). Both normalise to: { id, source, title, startMin, endMin, allDay, location }
// where startMin/endMin are minutes-from-midnight on the target local date.

function dateRangeUTC(dateISO) {
  const start = new Date(dateISO + "T00:00:00");
  const end = new Date(dateISO + "T00:00:00"); end.setDate(end.getDate() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString(), start, end };
}
// Minutes-from-midnight on the target local date, clamped to [0,1440].
function localMinOnDate(d, dayStart) {
  const diffMs = d.getTime() - dayStart.getTime();
  return Math.max(0, Math.min(1440, Math.round(diffMs / 60000)));
}

// ── Google Calendar ──
async function fetchGoogleEvents(dateISO) {
  if (!accessToken) return null;
  const { timeMin, timeMax, start } = dateRangeUTC(dateISO);
  // Fixed-commitment calendars + flexible work-block calendars (Claude's briefing
  // can drop the day's tasks onto a flex calendar; those flow into open time).
  const flexIds = (DATA.settings.flexCalendarIds || []).filter(Boolean);
  const fixedIds = ((DATA.settings.googleCalendarIds && DATA.settings.googleCalendarIds.length) ? DATA.settings.googleCalendarIds : ["primary"]).filter(id => flexIds.indexOf(id) < 0);
  const jobs = fixedIds.map(id => ({ id, flex: false })).concat(flexIds.map(id => ({ id, flex: true })));
  const out = [];
  for (const { id: calId, flex } of jobs) {
    const url = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) +
      "/events?singleEvents=true&orderBy=startTime&timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
    if (r.status === 401) { dropToken(); throw new Error("token expired"); }
    if (!r.ok) continue;
    const j = await r.json();
    (j.items || []).forEach(ev => {
      if (ev.status === "cancelled") return;
      const allDay = !!(ev.start && ev.start.date);
      let startMin, endMin;
      if (allDay) { startMin = 0; endMin = 1440; }
      else {
        startMin = localMinOnDate(new Date(ev.start.dateTime), start);
        endMin = localMinOnDate(new Date(ev.end.dateTime), start);
      }
      out.push({ id: "g_" + (ev.id || Math.random()), source: "google", title: ev.summary || "(no title)", startMin, endMin, allDay, location: ev.location || "", flex });
    });
  }
  return out;
}

// ── Outlook / generic ICS ──
function unfoldICS(text) {
  // RFC5545 line folding: a CRLF followed by space/tab continues the prior line.
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}
function parseICSDate(val, params) {
  // Returns { date: Date, dateOnly: bool }.
  const dateOnly = /VALUE=DATE/i.test(params || "") || /^\d{8}$/.test(val);
  if (/^\d{8}$/.test(val)) {
    const y = +val.slice(0, 4), m = +val.slice(4, 6) - 1, d = +val.slice(6, 8);
    return { date: new Date(y, m, d), dateOnly: true };
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return { date: new Date(val), dateOnly };
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), dateOnly: false }; // UTC
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), dateOnly: false }; // floating/local
}
const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function icsOccursOn(vev, targetDay) {
  // targetDay: Date at local midnight. Returns true if this VEVENT occurs that day.
  const ds = vev.start.date;
  const dsMid = new Date(ds.getFullYear(), ds.getMonth(), ds.getDate());
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (!vev.rrule) {
    // Multi-day all-day events span [DTSTART, DTEND) with an exclusive end date;
    // show on every day in that range (single-day events carry DTEND = next day).
    if (vev.start.dateOnly) {
      const de = vev.end && vev.end.date;
      let endExcl = de ? new Date(de.getFullYear(), de.getMonth(), de.getDate()) : new Date(dsMid.getTime() + 86400000);
      if (endExcl <= dsMid) endExcl = new Date(dsMid.getTime() + 86400000); // malformed/zero-length → single day
      return targetDay >= dsMid && targetDay < endExcl;
    }
    return sameDay(dsMid, targetDay);
  }
  if (targetDay < dsMid) return false;
  const r = vev.rrule;
  if (r.UNTIL) { const u = parseICSDate(r.UNTIL, "").date; if (targetDay > u) return false; }
  const interval = r.INTERVAL ? +r.INTERVAL : 1;
  const dayDiff = Math.round((targetDay - dsMid) / 86400000);
  if (r.FREQ === "DAILY") return dayDiff % interval === 0;
  if (r.FREQ === "WEEKLY") {
    // The day-of-week must match (BYDAY list, or the DTSTART weekday).
    const byday = r.BYDAY ? r.BYDAY.split(",").map(x => x.replace(/^[+-]?\d+/, "")) : null;
    const dowOK = byday ? byday.some(d => ICS_DAYS[d] === targetDay.getDay())
                        : (targetDay.getDay() === dsMid.getDay());
    if (!dowOK) return false;
    if (interval <= 1) return true;
    // Interval cadence is counted in whole calendar weeks, not in days-since-start:
    // snap both dates back to the start of their week (WKST default Monday) so a
    // BYDAY weekday earlier or later than DTSTART's weekday lands in the right week.
    const weekStart = (dt) => {
      const x = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Mon=0 … Sun=6
      return x;
    };
    const wkDiff = Math.round((weekStart(targetDay) - weekStart(dsMid)) / (7 * 86400000));
    return wkDiff % interval === 0;
  }
  // MONTHLY/YEARLY: only the exact recurrence anniversary handled loosely.
  if (r.FREQ === "MONTHLY") return targetDay.getDate() === dsMid.getDate();
  if (r.FREQ === "YEARLY") return targetDay.getDate() === dsMid.getDate() && targetDay.getMonth() === dsMid.getMonth();
  return sameDay(dsMid, targetDay);
}
function parseICS(text) {
  const lines = unfoldICS(text).split(/\r?\n/);
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":"); if (idx < 0) continue;
    const left = line.slice(0, idx), val = line.slice(idx + 1);
    const semi = left.indexOf(";");
    const key = (semi >= 0 ? left.slice(0, semi) : left).toUpperCase();
    const params = semi >= 0 ? left.slice(semi + 1) : "";
    if (key === "DTSTART") cur.start = parseICSDate(val, params);
    else if (key === "DTEND") cur.end = parseICSDate(val, params);
    else if (key === "SUMMARY") cur.title = val.replace(/\\,/g, ",").replace(/\\n/gi, " ").replace(/\\;/g, ";");
    else if (key === "LOCATION") cur.location = val.replace(/\\,/g, ",").replace(/\\n/gi, " ");
    else if (key === "UID") cur.uid = val;
    else if (key === "RRULE") {
      cur.rrule = {}; val.split(";").forEach(p => { const [k, v] = p.split("="); cur.rrule[k.toUpperCase()] = v; });
    }
  }
  return events;
}
async function fetchOutlookEvents(dateISO) {
  const raw = (DATA.settings.outlookIcsUrl || "").trim();
  if (!raw) return null;
  const proxy = (DATA.settings.corsProxy || "").trim();
  const url = proxy ? proxy + encodeURIComponent(raw) : raw;
  let text;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("ics " + r.status);
    text = await r.text();
  } catch (e) { throw new Error("ics-fetch"); }
  const target = new Date(dateISO + "T00:00:00");
  const targetMid = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const dayStart = new Date(dateISO + "T00:00:00");
  const out = [];
  parseICS(text).forEach(vev => {
    if (!icsOccursOn(vev, targetMid)) return;
    const dateOnly = vev.start.dateOnly;
    let startMin, endMin;
    if (dateOnly) { startMin = 0; endMin = 1440; }
    else {
      // For recurring events, shift the wall-clock time onto the target date.
      const s = vev.start.date, e = vev.end ? vev.end.date : new Date(s.getTime() + 3600000);
      const sOnTarget = new Date(targetMid); sOnTarget.setHours(s.getHours(), s.getMinutes(), 0, 0);
      const durMs = e.getTime() - s.getTime();
      startMin = localMinOnDate(sOnTarget, dayStart);
      endMin = Math.min(1440, startMin + Math.round(durMs / 60000));
    }
    out.push({ id: "o_" + (vev.uid || Math.random()) + "_" + startMin, source: "outlook", title: vev.title || "(no title)", startMin, endMin, allDay: dateOnly, location: vev.location || "" });
  });
  return out;
}

// ── Public: get cached events + refresh ──
function cachedEventsFor(dateISO) {
  const c = DATA.calCache[dateISO] || {};
  const ev = [].concat(c.google || [], c.outlook || []);
  // honour one-off removals from the day plan
  const removed = (DATA.dayPlans[dateISO] && DATA.dayPlans[dateISO].removedEventIds) || [];
  return ev.filter(e => removed.indexOf(e.id) < 0);
}
let calRefreshing = false;
async function refreshCalendars(dateISO) {
  dateISO = dateISO || todayISO();
  if (calRefreshing) return;
  calRefreshing = true;
  const cache = DATA.calCache[dateISO] || {};
  let changed = false;
  // Google
  if (DATA.settings.googleCalEnabled && accessToken) {
    try { const g = await fetchGoogleEvents(dateISO); if (g) { cache.google = g; changed = true; } }
    catch (e) { if (!accessToken && googleLinked()) trySilentConnect(); /* token expired — the tap-to-reauth listener also covers this */ }
  }
  // Outlook
  if ((DATA.settings.outlookIcsUrl || "").trim()) {
    try { const o = await fetchOutlookEvents(dateISO); if (o) { cache.outlook = o; changed = true; } }
    catch (e) { if (typeof toast === "function" && e.message === "ics-fetch") toast("Outlook feed blocked — see Settings"); }
  }
  cache.ts = Date.now();
  DATA.calCache[dateISO] = cache;
  calRefreshing = false;
  if (changed) { saveLocal(); if (typeof render === "function") render(); }
}
