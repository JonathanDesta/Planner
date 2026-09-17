# Campus rebuild · implementation and audit

This replaces the legacy global gap-filling scheduler and whole-file timestamp sync. The app remains static ES modules on the existing GitHub Pages path. No automatic nighttime, reading or study blocks remain.

## Architecture

- `js/dates.js`: Chicago date arithmetic and wall-clock conversion; a fixed daily wake time with exactly 420 elapsed sleep minutes, including clock changes.
- `js/routines.js`: ordered atomic steps, Sunday recurrence, resource reservation, durable runner state and corrections. Standard/Mon–Thu/ordinary Sunday/grooming Sunday budgets are 70/110/82/110 minutes. The grooming anchor is 2026-09-20. Vacuuming is weekly. The three-minute cold shower cannot be edited shorter.
- `js/facilities.js`: effective-dated official dining and gym hours, orientation exceptions, personal overrides and source metadata.
- `js/travel.js`: building aliases with room text retained, known campus estimates, distance fallback, pedestrian route results and personal overrides. Door-to-door transitions are included once. Unknown locations reserve time and remain visibly identified.
- `js/timeline.js`: deterministic bounded search over meals, full workouts and flexible commitments, including every journey before acceptance. Fixed calendar/personal events and actual activity times remain pinned. It returns primary blocks, display segments, free time, unplaced items and explicit conflicts. Final validation checks overlaps, sleep, facility availability, bathroom resources and location continuity. The search retains alternate dining locations across intermediate layers. It is a bounded heuristic, not a proof that every conceivable packing has been exhausted.
- `js/calendar.js`: rolling-window pagination, expanded recurrence/exception instances, cancellations, declined events, calendar-qualified identities and specific series location overrides. All-day and explicitly transparent events remain visible as date information. Planner makes no Calendar writes.
- `js/workout.js`: validates the version-1 Oly read-only feed. Current actual dates come from Oly. Future previews retain the rolling A–B–rest–C–D–rest–rest rhythm from Oly’s next A date, including shifted weekdays, and the current dose until Oly advances the program.
- `js/state.js`: schema-2 validation, optimistic multi-tab saves, last-valid backup, legacy migration and per-record sync projection. Credentials and cached calendar events are excluded from the cloud projection.
- `js/cloud-sync.js`: immutable private Drive revision DAG, parent references, deletion markers, independent-change merge, explicit edit/edit and edit/delete conflicts, paginated reads, safe retries, and durable IndexedDB revision queues. Oly and Planner use distinct namespaces and byte-identical protocol modules.
- `js/app.js`: persistent page containers and Oly iframe, origin-checked feed/token messages, editing guards, per-page scroll, keyboard-focus restoration, minute-based replanning and source freshness. A refresh never recreates the workout frame.
- `sw.js`: complete-version atomic precache, own-path interception, own-prefix cleanup and deferred update activation.

## Timing audit

The default 05:15 start ends the Monday/Thursday bathroom sequence at approximately 06:50 and the complete morning at 07:05. Ordinary mornings end 06:25; ordinary Sundays 06:37. Grooming Sundays end 07:05. Setup, room/bathroom transitions and six minutes of contingency are explicit. Masque processing occurs during other steps.

Meals reserve 35/45/45 minutes, independently of walking. The location chain respects physical home stops and keeps the physical origin through virtual events. Initial Grossman–Cathey and Grossman–Ratner allowances are five and twenty minutes. Tight ten-minute class transfers were checked individually: the initial Ryerson–BSLC allowance consumes the full gap; Cobb–Kersten uses eight minutes. These are estimates, with no claim of a live measured route. Five-minute early class arrival is an extra preference only where space permits.

The private imported autumn calendar was checked without adding its instances to this repository. The Tuesday evening location override and Thursday lab constraint were included. Introductory Thursday C fits with dinner at Bartlett near Ratner when Cathey would prevent a complete visit. The longer full-dose C needs later verified gym availability or another reviewed arrangement. No dose, rest or training day is shortened to make the display appear feasible.

The unmatched B forecast stays provisional and visibly unplaced when necessary, without a standing unmeasured-B alert. A synthetic 136-minute calibrated B is a regression fixture, not an assertion about an actual observation. Calibrated conflicts expose the available window and shortfall before any program change.

Ratner's official page, checked September 16, 2026, still publishes summer hours through September 27. Later dates use a clearly labeled conservative fallback; later evening availability is not confirmed. Dining includes the summer Baker-only period, dated orientation exceptions, and Woodlawn Saturday dinner under regular hours. New holiday or term changes need dated updates from official sources.

Sources: [Ratner](https://athletics.uchicago.edu/sports/2023/6/12/facilities.aspx), [Dining](https://dining.uchicago.edu/locations-and-hours), [Orientation hours](https://dining.uchicago.edu/-/media/project/uchicago-tenant/dining/documents/o-week-2026.pdf), [Summer update](https://dining.uchicago.edu/-/media/project/uchicago-tenant/dining/documents/august-update-summer-hours-2026.pdf).

## Verification

Scheduler tests cover exact routines and order, alternate Sundays, bathroom closures/delays/actual overruns, DST, route origins, retained unplaced items, fixed and active commitments, dining exceptions, alternative meal placements, one daily/four weekly visits, free-time unions, Calendar pagination/cancellations, private migration and malformed feeds.

Chrome and WebKit browser coverage checks 320/390-pixel layouts and desktop, commitment creation/editing, reload/pause/undo without automatic step completion, stable iframe identity, unsaved settings, offline startup and cache isolation. A separate two-device test checks IndexedDB persistence, offline queues, pagination, simultaneous changes, explicit conflict resolution, deletion and rapid updates. All Google traffic is simulated in those tests.

Oly retains the source-prescription and complete-program regression suites, adds scoped calibration/coverage/readiness/date/feed tests, and exercises sync merge integrity through a 5,000-revision history. Its existing automatic stage/session timing is retained unchanged. Deliberate interruption exclusions affect forecasts only.

Manual screenshot review covered readable contrast, expandable timing details, bottom navigation, focus restoration, touch targets and preserved embedded state. A 320-pixel intrinsic form-width defect and a search-pruning defect that hid feasible alternate dining were fixed during this audit.

The final suites passed 18 Planner and 114 Oly Node tests, all nine existing Oly browser scripts, and both Planner browser scripts under Chrome and WebKit. WebKit cold-offline verification stops the origin server because its protocol-level offline flag rejects navigation before consulting the service worker.

Live Google consent cannot be automated on behalf of a disconnected device. The code can queue edits offline, but cannot promise synchronization while an iPhone app is closed. See [Google token behavior](https://developers.google.com/identity/oauth2/web/guides/use-token-model).
