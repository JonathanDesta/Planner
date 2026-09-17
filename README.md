# Day · Campus Planner

[Open Planner](https://jonathandesta.github.io/Planner/) · [Open Oly](https://jonathandesta.github.io/oly-tracker/)

An offline-capable campus planner with five views: Today, Week, Morning, Workout and Settings. Google Calendar is read-only. Personal commitments and preferences stay in Planner; Oly owns the training journal and publishes a versioned scheduling feed.

The default day wakes at 05:15 Chicago time and protects seven elapsed hours before the next wake-up. Normal bedtime is 22:15. Meals, walking, building transitions, morning steps and changing time have separate allowances. Remaining time stays free.

## Development

Use Node 22+ and Chrome. Keep `oly-tracker` beside this checkout for cross-app tests and local embedding.

```sh
npm ci
npm start
npm test
npm run test:browser
npm run format:check
```

For Safari-engine checks, install WebKit with `npx playwright install webkit` and run `PLANNER_BROWSER_ENGINE=webkit npm run test:browser`.

The development server exposes `/Planner/` and `/oly-tracker/` on the same origin. Test fixtures use isolated browser contexts and simulated Google responses. They never write to a real Google account.

See [Setup](SETUP.md), [Architecture and audit](HANDOFF.md) and [Release workflow](WORKFLOW.md).

Planner 2.0.5 uses Thursday-only hair care and Tuesday/Thursday/Saturday face shaving after drying off, before skincare. It follows Oly’s explicit weekday schedule (Mon B / Tue C / Thu A / Fri D), retains the separate test-week Saturday bench, and respects actual logged bench eligibility when placing current sessions. It does not change Oly prescriptions or write Calendar events.
