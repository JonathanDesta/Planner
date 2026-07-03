'use strict';
// ─── Travel-time engine ───────────────────────────────────────────────────────
// Default path is FREE and needs no key:
//   • Geocode addresses with OpenStreetMap Nominatim (cached permanently).
//   • Driving time from the public OSRM demo server (cached per origin→dest).
//   • Walking/transit estimated from road distance when no key is set.
// Optional: paste a Google Maps JS API key in Settings to use live, traffic-aware
// Distance Matrix instead (loaded lazily through the Maps JS SDK).
//
// The timeline reads travel times *synchronously from cache*; anything missing is
// fetched in the background by prefetchTravel(), which re-renders when it lands.

const GEOCODE_TTL = 1000 * 60 * 60 * 24 * 180; // 180 days
const ROUTE_TTL = 1000 * 60 * 60 * 24 * 14;    // 14 days (no traffic in free mode)
let travelInFlight = new Set();
let gmapsPromise = null;

function normAddr(a) { return (a || "").trim().toLowerCase().replace(/\s+/g, " "); }

// Calendar "locations" that aren't physical places — video-call links, app names,
// phone bridges — get NO travel legs. Kept conservative on purpose: a room-only
// location ("Room 204") is usually a real building the geocoder just can't parse,
// so those keep the fallback travel buffer rather than silently losing travel.
function isVirtualLoc(loc) {
  const l = (loc || "").trim().toLowerCase();
  if (!l) return false;
  if (/^(https?:\/\/|www\.)/.test(l)) return true; // any link
  if (/(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|gotomeeting\.com|gotomeet\.me|skype\.com|discord\.gg|discord\.com|hangouts\.google)/.test(l)) return true;
  if (/^(zoom|google meet|meet|microsoft teams|teams|webex|skype|facetime|discord|google hangouts?|online|virtual|virtual meeting|remote|phone|phone call|call|conference call|dial[- ]?in|video call|tbd|n\/a)$/.test(l)) return true;
  if (/\b(zoom|teams|webex|google meet|skype)\b.*\b(meeting|call|link|url)\b/.test(l)) return true;
  return false;
}

// ── Geocoding ──
function geocodeCached(addr) {
  const k = normAddr(addr);
  const p = DATA.places[k];
  if (p && p.lat != null && (Date.now() - (p.ts || 0) < GEOCODE_TTL)) return p;
  return null;
}
// TomTom's geocoder resolves business/POI names ("Crunch Chamblee") that the free
// Nominatim geocoder often can't — the usual reason a TomTom travel time never loads.
async function tomtomGeocode(addr) {
  const key = (DATA.settings.tomtomKey || "").trim();
  if (!key) return null;
  try {
    const url = "https://api.tomtom.com/search/2/geocode/" + encodeURIComponent(addr) + ".json?limit=1&key=" + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) throw new Error("ttgeo " + r.status);
    const j = await r.json();
    const res = j.results && j.results[0];
    if (!res || !res.position) return null;
    return { lat: res.position.lat, lon: res.position.lon, label: (res.address && res.address.freeformAddress) || addr, ts: Date.now() };
  } catch (e) { return null; }
}
async function nominatimGeocode(addr) {
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(addr);
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("geocode " + r.status);
    const j = await r.json();
    if (!j.length) return null;
    return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), label: j[0].display_name, ts: Date.now() };
  } catch (e) { return null; }
}
async function geocode(addr) {
  if (!addr) return null;
  const cached = geocodeCached(addr);
  if (cached) return cached;
  // Prefer TomTom (far better at business/POI names); fall back to free Nominatim.
  let place = await tomtomGeocode(addr);
  if (!place) place = await nominatimGeocode(addr);
  if (!place) return null;
  DATA.places[normAddr(addr)] = place;
  saveLocal();
  return place;
}

// ── Distance / fallback ──
function haversineKm(a, b) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function estimateSec(o, d, mode) {
  const km = haversineKm(o, d) * 1.3; // rough road detour factor
  const kmh = mode === "walking" ? 4.8 : mode === "transit" ? 22 : 38;
  return Math.round((km / kmh) * 3600);
}

// ── Route key + sync cache read ──
function routeKey(o, d, mode) { return `${o.lat.toFixed(4)},${o.lon.toFixed(4)}|${d.lat.toFixed(4)},${d.lon.toFixed(4)}|${mode}`; }
function routeCached(o, d, mode) {
  const c = DATA.routeCache[routeKey(o, d, mode)];
  if (c && (Date.now() - (c.ts || 0) < ROUTE_TTL)) return c.sec;
  return null;
}

// ── Real-traffic providers only (no time-of-day heuristic) ──
// Travel time comes from TomTom's live/predictive routing (priced for each trip's
// own weekday + departure-time bucket) or, if a Google Maps key is set, Google's
// live-traffic Distance Matrix. There is NO fabricated "rush-hour" scaling — until
// a real value has loaded we show a plain free-flow placeholder, clearly labeled
// "approx", and replace it the moment the real number arrives.
function tomtomEnabled() { return !!(DATA.settings.tomtomKey || "").trim() && DATA.settings.travelMode !== "transit" && !(DATA.settings.mapsApiKey || "").trim(); }
function ttBucket(min) { return Math.floor((((Math.round(min || 0) % 1440) + 1440) % 1440) / 30) * 30; }
function ttKey(o, d, mode, departMin, dow) { return `${o.lat.toFixed(4)},${o.lon.toFixed(4)}|${d.lat.toFixed(4)},${d.lon.toFixed(4)}|${mode}|tt|${dow}|${ttBucket(departMin)}`; }
const TT_TTL = 1000 * 60 * 60 * 24 * 3; // predictive pattern refreshes every 3 days

// Synchronous best-effort travel time between two addresses, from cache.
// Returns { sec, exact, base, factor, live } or null if either endpoint isn't geocoded.
function travelSecCached(originAddr, destAddr, mode, departMin, dow) {
  mode = mode || (DATA.settings.travelMode || "driving");
  const o = geocodeCached(originAddr), d = geocodeCached(destAddr);
  if (!o || !d) return null;
  // TomTom live/predictive: the real travel time for this weekday + time bucket.
  if (tomtomEnabled()) {
    const c = DATA.routeCache[ttKey(o, d, mode, departMin, dow)];
    if (c && (Date.now() - (c.ts || 0) < TT_TTL)) return { sec: c.sec, exact: true, base: c.base, factor: c.factor, live: true };
    // real value not fetched yet → provisional free-flow placeholder (no traffic scaling)
    const est = estimateSec(o, d, mode);
    return { sec: est, exact: false, base: est };
  }
  // Google Distance Matrix (live traffic) stores its result in routeCache when a Maps key is set.
  const base = routeCached(o, d, mode);
  if (base != null) return { sec: base, exact: true, base };
  const est = estimateSec(o, d, mode);
  return { sec: est, exact: false, base: est };
}

// ── Live fetch (background) ──
async function osrmDuration(o, d) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${o.lon},${o.lat};${d.lon},${d.lat}?overview=false`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("osrm " + r.status);
    const j = await r.json();
    if (j.routes && j.routes[0]) return Math.round(j.routes[0].duration);
  } catch (e) {}
  return null;
}
function loadGoogleMaps(key) {
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    if (window.google && google.maps && google.maps.DistanceMatrixService) return resolve();
    const s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key);
    s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error("maps load"));
    document.head.appendChild(s);
  });
  return gmapsPromise;
}
async function googleDuration(o, d, mode) {
  try {
    await loadGoogleMaps(DATA.settings.mapsApiKey);
    const svc = new google.maps.DistanceMatrixService();
    const travelMode = mode === "walking" ? "WALKING" : mode === "transit" ? "TRANSIT" : "DRIVING";
    return await new Promise((resolve) => {
      svc.getDistanceMatrix({
        origins: [{ lat: o.lat, lng: o.lon }], destinations: [{ lat: d.lat, lng: d.lon }],
        travelMode, drivingOptions: travelMode === "DRIVING" ? { departureTime: new Date() } : undefined,
      }, (res, status) => {
        if (status !== "OK") return resolve(null);
        const el = res.rows[0].elements[0];
        if (el.status !== "OK") return resolve(null);
        resolve(Math.round((el.duration_in_traffic || el.duration).value));
      });
    });
  } catch (e) { return null; }
}

// TomTom Routing with departAt → real predictive (or live) travel time.
// Returns { sec, base, factor } where base = no-traffic time, factor = delay ratio.
function isoDepartAt(dateISO, departMin) {
  const d = new Date(dateISO + "T00:00:00");
  d.setMinutes(departMin || 0);
  const now = Date.now();
  if (d.getTime() < now + 60000) d.setTime(now + 60000); // TomTom rejects past departAt
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-";
  const p = n => String(Math.abs(n)).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
async function tomtomDuration(o, d, mode, departMin, dateISO) {
  try {
    const tm = mode === "walking" ? "pedestrian" : mode === "bicycle" ? "bicycle" : "car";
    const departAt = encodeURIComponent(isoDepartAt(dateISO, departMin));
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${o.lat},${o.lon}:${d.lat},${d.lon}/json?key=${encodeURIComponent((DATA.settings.tomtomKey || "").trim())}&travelMode=${tm}&traffic=true&departAt=${departAt}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("tomtom " + r.status);
    const j = await r.json();
    const s = j.routes && j.routes[0] && j.routes[0].summary;
    if (!s) return null;
    const sec = s.travelTimeInSeconds;
    const base = s.noTrafficTravelTimeInSeconds || sec;
    return { sec, base, factor: base ? sec / base : 1 };
  } catch (e) { return null; }
}

// Fetch any travel pairs not yet cached, then re-render once.
// `pairs` = [{ origin, dest, whenMin, dow }] (whenMin/dow used only for TomTom).
async function prefetchTravel(pairs, mode) {
  mode = mode || (DATA.settings.travelMode || "driving");
  const today = (typeof todayISO === "function") ? todayISO() : new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const { origin, dest, whenMin, dow, dateISO } of pairs) {
    if (!origin || !dest) continue;
    const o = await geocode(origin), d = await geocode(dest);
    if (!o || !d) continue;

    if (tomtomEnabled()) {
      const key = ttKey(o, d, mode, whenMin, dow);
      if (DATA.routeCache[key] && (Date.now() - DATA.routeCache[key].ts < TT_TTL)) continue;
      if (travelInFlight.has(key)) continue;
      travelInFlight.add(key);
      const res = await tomtomDuration(o, d, mode, whenMin, dateISO || today);
      if (res) { DATA.routeCache[key] = { sec: res.sec, base: res.base, factor: res.factor, ts: Date.now() }; changed = true; }
      travelInFlight.delete(key);
      await new Promise(r => setTimeout(r, 350));
      continue;
    }

    // Free path: cache the time-independent free-flow base (OSRM / Google / estimate).
    const key = routeKey(o, d, mode);
    if (DATA.routeCache[key] && (Date.now() - DATA.routeCache[key].ts < ROUTE_TTL)) continue;
    if (travelInFlight.has(key)) continue;
    travelInFlight.add(key);
    let sec = null;
    if ((DATA.settings.mapsApiKey || "").trim()) sec = await googleDuration(o, d, mode);
    if (sec == null && mode === "driving") sec = await osrmDuration(o, d);
    if (sec == null) sec = estimateSec(o, d, mode);
    DATA.routeCache[key] = { sec, ts: Date.now() };
    travelInFlight.delete(key);
    changed = true;
    await new Promise(r => setTimeout(r, 1100)); // be polite to the free endpoints
  }
  if (changed) { saveLocal(); if (typeof render === "function") render(); }
}
