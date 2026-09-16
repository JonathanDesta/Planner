# Release workflow

The production apps are static GitHub Pages sites at their existing paths. Deploy the compatible Oly scheduling/sync integration before publishing a Planner version that consumes it.

1. Keep both repositories checked out side by side. Preserve user journals, calendar caches, OAuth tokens and routing credentials outside Git.
2. Run Oly's `npm test`, `npm run test:browser`, and `npm run format:check`. These include the original source, duration, migration, pacing, 52-week execution and browser regressions.
3. Run Planner's `npm test`, `npm run test:browser`, and `npm run format:check`. Inspect the generated mobile and desktop screenshots. Browser tests simulate Google; live authorization requires the user's own connection.
4. Review the timing ledger against the current private calendar, facility sources and actual calibration. Do not commit the calendar or ledger. Check the daily/weekly visit limits, three meals, route continuity, sleep, bathroom constraints and retained conflicts.
5. Review `git diff --check`, changed worker asset lists and repository privacy. Increment cache identities for new code releases. Both shared Google-auth and Drive-sync modules must match byte for byte.
6. Publish Oly, wait for Pages to complete, then run `npm run check:deployment` there. This compares the SHA-256 of every cached production asset against the local release.
7. Publish Planner and run its deployment check. Open both public paths in an isolated browser and verify the versioned feed and five-view navigation.

Browser artifacts go in ignored `test-results/`. Public audit documents describe test coverage and limitations, not private calendar instances or real journals. A service-worker update must never clear application storage or another application's caches.
