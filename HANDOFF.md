# Day — Life Manager · Handoff / Passdown

A debugging + continuation brief for a fresh chat. Everything you need to understand,
run, test, and deploy this app without re-deriving it.

---

## 1. What it is

A single-page, no-backend **PWA** ("Day") that runs the user's whole day on one
master timeline: morning & nighttime routine runners, a workout-time block mirrored
from a sister app, calendar events with travel time, and an adaptive timeline that
detects conflicts and back-solves wake/leave times.

- **Source of truth (edit here):** `C:\LifeManager`
- **Deployed to:** GitHub repo **`JonathanDesta/GymApp`**, branch `main`
- **Live URL (installed on the user's iPhone as a PWA):** https://jonathandesta.github.io/GymApp/
- **Current service-worker cache version:** `day-v17` (in `sw.js`)
- The repo is **PUBLIC** — never hard-code secrets (keys, Outlook feed URL) into source.

> Note: `C:\GymApp` is a DIFFERENT, older app (the original Routines+Lifts app). The
> live GymApp Pages site now serves THIS app (Day) — Day replaced it. Don't confuse them.

---

## 2. Run locally (preview)

A launch config named **`day`** exists in `C:\GymApp\.claude\launch.json` (the preview
project root is `C:\GymApp`). It serves `C:/LifeManager` statically:

```
python -m http.server 5599 --directory C:/LifeManager
```

Use the preview tools: `preview_start` with name `day`, then `preview_eval` /
`preview_snapshot` / `preview_screenshot`. Set `preview_resize` to `mobile` (it's a
phone app).

**localhost caveats (important for debugging):**
- `localhost:5599` is a different ORIGIN than the live site, so on localhost:
  - The embedded workout app's data (`oly_state`) is **not shared** → `workoutBlockState()`
    falls back to `DATA.workout` defaults (Block 1).
  - Google sign-in / Drive sync / Google Calendar **won't auth** (origin not whitelisted).
  - Nominatim/OSRM/TomTom (travel) and Outlook ICS DO work from localhost (CORS ok),
    but need real geocodable addresses.
- Best way to test the solver: inject `DATA` via `preview_eval` and call
  `computeTimeline(iso)` / `render()` directly (see §7).

---

## 3. Deploy

The deploy flow (repo uses `core.autocrlf=true`, so CRLF warnings on copy are normal):

```bash
# clone once to a temp dir (or reuse), then each deploy:
cd "$TEMP/gymapp_deploy" && git pull -q origin main
cp C:/LifeManager/index.html C:/LifeManager/sw.js C:/LifeManager/manifest.json .
cp C:/LifeManager/js/*.js js/
# (also copy any changed *.md / icons)
# ALWAYS bump CACHE_VERSION in sw.js (day-vN) so the installed PWA refreshes
git add -A && git commit -m "..." && git push origin main
# poll the live URL with a cache-buster until the change appears, e.g.:
curl -s "https://jonathandesta.github.io/GymApp/sw.js?cb=$(date +%s)" | grep -o 'day-v[0-9]*'
```

Pages takes ~30–60s to publish. **Bumping `CACHE_VERSION` is mandatory** — the SW is
network-first for app code, but the version bump guarantees old caches are purged.

---

## 4. File map

```
index.html      shell + ALL css + <script> tags (load order matters, see below)
manifest.json   PWA manifest (name "Day", theme #10182b)
sw.js           service worker — network-first for app code; PASSES THROUGH external
                APIs (googleapis, nominatim, osrm, api.tomtom.com, office365, …).
                CACHE_VERSION lives here.
icon-192.png / icon-512.png
SETUP.md        end-user setup (Google OAuth, Outlook ICS, TomTom, install)
WORKFLOW.md     the Claude-briefing → flex-calendar workflow
HANDOFF.md      this file
js/state.js     DATA model, defaults, PRESET, migrations, persistence, Google
                Identity Services + Drive sync, shared helpers (loads FIRST)
js/routines.js  morning/night SEEDs, alarm/wake-lock, the timed step runner, drops
js/workout.js   workout-duration mirror + embedded oly-tracker iframe + oly_state sync
js/calendar.js  Google Calendar + Outlook .ics fetch/parse → normalized events
js/travel.js    geocode (TomTom-first, Nominatim fallback) + TomTom live/predictive
                routing (departAt); OSRM free-flow only as a no-key fallback
js/timeline.js  computeTimeline(dateISO) — THE SOLVER
js/app.js       render() dispatcher, tabs, Today view, look-ahead, settings, init
```

Script load order (in `index.html`): state → routines → workout → calendar → travel →
timeline → app. Cross-file calls resolve at runtime, so e.g. `routines.js` calling
`lookAheadHTML()` (defined in app.js) is fine.

Tabs: **Today, Morning, Night, Workout, Settings** (`CUR` global; `render()` dispatches).

---

## 5. Data model

Everything lives in one global `DATA` object (in `state.js`), persisted to
`localStorage["day_cache_v1"]` and (when Google connected) to a Drive file
`day_lifemanager.json`.

```
DATA = {
  version, updated,
  migratedNoWorkBlocks, presetApplied,        // one-time migration flags
  routineConfig: { v, steps[], transitionSec },   // morning (ROUTINE_VERSION=7)
  nightConfig:   { v, steps[], transitionSec },   // night   (NIGHT_VERSION=2)
  routineLog[], nightLog[],                        // per-day completion logs
  workout: { blockId, weekInBlock, cutting, departTime, days[] },  // mirror fallback
  settings: { googleClientId, googleCalEnabled, googleCalendarIds[],
              flexCalendarIds[], outlookIcsUrl, corsProxy,
              homeAddress, gymAddress, wakeTime, bedTime,
              travelMode, tomtomKey,
              mapsApiKey, defaultTravelMin, workoutAppUrl },
  olyState: { data:<oly_state>, ts } | null,   // synced snapshot of the workout app
  places:    { normAddr -> {lat,lon,ts} },     // geocode cache
  routeCache:{ key -> {sec,ts} | {sec,base,factor,ts} },  // route cache (free + TomTom)
  dayPlans:  { 'YYYY-MM-DD' -> dayPlan },
  calCache:  { 'YYYY-MM-DD' -> { google:[], outlook:[], ts } },
}

dayPlan(date) = { tasks:[{id,name,durMin,fixedStart?,location?}], removedEventIds:[],
                  wakeTime?, bedTime?,                         // per-day overrides
                  workoutDepart?, workoutSkip?,                // gym overrides
                  nightMode?('bed'|'beforeOut'), nightOutTime?,// night-before-out
                  dropSteps?[] }                               // amputated morning steps
```

Normalized calendar event: `{ id, source('google'|'outlook'), title, startMin, endMin,
allDay, location, flex? }` where startMin/endMin are minutes-from-midnight local.

---

## 6. The solver — `computeTimeline(dateISO)` (timeline.js)

Returns `{ segments[], conflicts[], leaveBy, wakeBy, firstCommit, morningClash,
allDayEvents, wakeMin, bedMin, mDur, nDur, workMin, dropList, busyMin, pending }`.

Build order:
1. **Morning routine** anchored at wake (`mDur` is drop-aware via `routineBudgetSec(cfg,dow,dropList)`).
2. **Calendar events + fixed tasks** placed at their times. `flex`-calendar events are
   split out → handled in §4 as gap-filled work blocks. Early events flag a conflict.
3. **Workout** (flexible): reserve `travel+workMin+travel`, place near `departTime`
   (default 3pm), relocate if its slot is taken (`findGap`).
4. **Flexible tasks** + **flex work blocks** → `findGap` into open time (preferred start).
5. **Travel chain pass:** for every located block, inbound leg starts from the previous
   located block (default home), outbound to the next (default home); returns home on
   gaps > GROUP_GAP(90min). Each leg timed for its own clock time → traffic per leg.
6. **Night routine:** ends at bedtime, OR at `nightOutTime` when `nightMode==='beforeOut'`.
7. **Free fill** + **back-solve:** `leaveBy` (next departure), `wakeBy` (earliest commitment
   − travel − mDur), `firstCommit`, `morningClash` (wakeBy < wakeMin).

Segment statuses: `ok | conflict | moved | tight | free`. Badges in `badgeFor()` (app.js).

---

## 7. How to test the solver fast

Inject state and call directly via `preview_eval`:

```js
localStorage.clear(); DATA = defaultData(); normalizeData();
var t = todayISO();
DATA.settings.homeAddress="Home"; DATA.settings.gymAddress="Gym";
DATA.places = { home:{lat:40,lon:-75,ts:Date.now()}, gym:{lat:40.02,lon:-75.01,ts:Date.now()} };
// route cache key: `${o.lat.toFixed(4)},${o.lon.toFixed(4)}|${d...}|${mode}`
DATA.calCache[t] = { google:[{id:"g1",source:"google",title:"Class",startMin:540,endMin:600,allDay:false,location:""}], outlook:[], ts:Date.now() };
var tl = computeTimeline(t);
JSON.stringify(tl.conflicts);                         // inspect
CUR='Today'; render();                                // then snapshot/screenshot
```

To test tomorrow's look-ahead: put events in `DATA.calCache[tomorrowISO()]`, then
`lookAheadHTML(true)` returns the card HTML; `morningClash`/`wakeBy`/`firstCommit` on
`computeTimeline(tomorrowISO())` drive it.

---

## 8. Feature inventory (where each lives)

- **Routine runners** (morning/night): `routines.js`. Timed steps, ahead/behind pace,
  alarm (media `<audio>` so it sounds on silent) + Screen Wake Lock, cold/parallel
  sub-timers, in-app editing, re-seed on version bump, history + last-7 avg.
- **Workout tab = embedded live oly-tracker** (`workout.js`): iframe to
  `https://jonathandesta.github.io/oly-tracker/`. Same origin on the live site → shares
  `localStorage["oly_state"]`. `captureOlyState()`/`seedOlyDown()` bridge that data into
  Day's Drive sync (storage event + visibilitychange + 5s poll). `WORKOUT_TOTALMIN` table
  + `workoutDurationMin()` size the gym block on the timeline. Oly-tracker's OWN sw is
  network-first, so its updates auto-appear.
- **Calendars** (`calendar.js`): Google (read-only, via GSI token; `googleCalendarIds`
  fixed + `flexCalendarIds` flexible) and Outlook published `.ics` (parsed locally, basic
  RRULE expansion, optional `corsProxy`).
- **Travel + traffic** (`travel.js`): REAL traffic only — **TomTom** live/predictive
  via `departAt` (`tomtomKey`, cached per weekday + 30-min bucket, 3-day TTL). TomTom's
  Search API also geocodes (handles POI names; Nominatim is the no-key fallback).
  No fabricated time-of-day scaling exists (removed in day-v14); before a real value
  loads, a plainly-labeled "approx" free-flow placeholder shows. Optional Google Maps key.
  `isVirtualLoc()` (day-v16) skips travel for video-call/URL "locations" (Zoom/Meet/
  Teams/links) and keeps them out of the travel chain; room-only locations ("Room 204")
  intentionally KEEP the fallback buffer — they're physical, just not geocodable.
- **Master timeline** (`timeline.js` + Today view in `app.js`): §6 above.
- **Night routine "before I go out"** (`timeline.js` §5 + Today adjustments): per-day
  `nightMode`/`nightOutTime`.
- **Night-before look-ahead** (`app.js` `lookAheadHTML`/`bindLookAhead`): evening alert
  (Today after 17:00 + Night start screen). Offers wake-earlier / move-reading-out / both.
  Move-reading sets `dayPlan.dropSteps=["read"]` + adds a 90-min reading task.
- **Personal preset** (`state.js` `PRESET_SETTINGS`/`PRESET_WORKOUT`/`applyPreset`):
  seeded on fresh install, applied once via `presetApplied` migration (NEVER overwrites
  credentials), re-appliable via Settings → "Reset to my preset".

---

## 9. End-user setup still required (NOT in repo — credentials)

The user enters these once in **Settings**; they persist on-device + Drive:
- **Google OAuth Client ID** (`DEFAULT_CLIENT_ID` is empty). Needs a Web OAuth client
  with authorized origin `https://jonathandesta.github.io`, Calendar + Drive APIs enabled.
  Until set: no Drive sync, no Google Calendar. (See SETUP.md.)
- **Outlook `.ics` feed URL** (school calendar). May be CORS-blocked → `corsProxy`.
- **TomTom API key** (free, no card) for live/predictive traffic AND geocoding; without
  it, travel times fall back to free-flow OSRM (no traffic) and Nominatim geocoding.
- **Connect Google** (sync pill under the title) — makes settings permanent/cross-device.

---

## 10. Known limitations / debug watch-list

1. **Preset addresses may not geocode.** "1094 Sans Souci Way" / "Crunch Chamblee" likely
   need ", Chamblee, GA" appended (in Settings) or travel falls back to `defaultTravelMin`
   (15 min). First thing to check if travel times look wrong.
2. **iOS per-PWA storage isolation:** the embedded workout app's data inside Day is a
   separate box from the user's standalone Oly-Tracker install, unless bridged (one-time
   JSON export→import, or Drive sync). A code update to oly-tracker reaches both; data does not.
3. **No real night-before push notification** (no backend) — the look-ahead is an in-app
   evening alert. Relies on the user opening the app at night (they do, for the night routine).
4. **Moved-reading block has no per-step timer** (it's a plain task).
5. **Outlook ICS RRULE expansion is basic** (DAILY/WEEKLY/BYDAY/UNTIL/INTERVAL; MONTHLY/
   YEARLY loose). Recurring class schedules work; exotic rules may not.
6. **Workout mirror only reads `oly_state` on the deployed same-origin site**, not on
   localhost (different origin) — expect Block-1 fallback in local preview.
7. **bedTime "00:45" is after midnight** — timeline rolls `bedMin` past 1440 (handled);
   watch for off-by-a-day if you touch that math.
8. Traffic heuristic is an approximation; only TomTom is "real."
9. **`seedOlyDown()` has no recency guard** — it overwrites local `oly_state` with
   `DATA.olyState` whenever they differ, with no timestamp check. Safe in normal use
   (Day's embedded iframe is the sole writer and `captureOlyState()` runs on
   tab-leave/poll/visibilitychange, so they stay in sync), but if a stale snapshot
   ever wins a Drive reconcile while local is newer, a just-logged workout could be
   clobbered. Not fixed: can't verify on localhost (oly_state is different-origin
   there). If touching the sync bridge, capture-then-compare before seeding.

---

## 11. Companion context files

- `ROUTINES_CONTEXT.md` (in `C:\GymApp`) — the original morning/night routine spec the
  SEEDs were ported from.
- `SETUP.md`, `WORKFLOW.md` (in this folder) — end-user docs.
- Auto-memory: `C:\Users\Jonathan\.claude\projects\C--GymApp\memory\day-lifemanager.md`
  (loads automatically in the GymApp project; mirrors much of this).

---

## 12. Conventions

- Bump `sw.js` `CACHE_VERSION` every deploy.
- Keep secrets out of source (repo is public).
- Per-day overrides go in `dayPlan(date)`, never in global settings.
- Times are "HH:MM" strings ↔ minutes via `hmToMin`/`minToHM`; display via `fmtClock`.
- Test the solver by injecting `DATA` + calling `computeTimeline()` (§7), not by clicking.
