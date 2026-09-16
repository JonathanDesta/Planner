# Setup

The existing GitHub Pages URL remains unchanged. Open the app once online before relying on its offline version. On iPhone, add Planner and Oly to the Home Screen independently if desired.

## Google connection

1. Use one Google Cloud OAuth web client for both apps. Enable the Google Calendar API and Google Drive API.
2. Set the authorized JavaScript origin to `https://jonathandesta.github.io`. Include your localhost origin separately when developing. Do not enter a URL path as an origin.
3. Configure consent for `https://www.googleapis.com/auth/calendar.readonly` and `https://www.googleapis.com/auth/drive.file`. If the OAuth application is in testing, add the intended account as a test user.
4. In Planner Settings, save the client ID and calendar IDs (`primary` by default), then press **Connect Google**. Existing Planner connection settings migrate locally. The embedded Oly app receives the same client ID and temporary token through an origin-checked message.
5. On a separate device or standalone Oly context, use the same client ID and Google account and press **Connect Google** there as needed.

Tokens remain in session storage and are never added to journals, exports of application state, Drive revision contents, or the public repositories. Client IDs and optional routing keys remain device settings. No client secret is needed in this static application.

The Google token model requires an explicit reconnect after authorization expires. Sync runs while an app is open and connected: on opening, foregrounding, meaningful changes, completion, and a visible periodic retry. A closed iPhone web app cannot be promised background synchronization. See [Google's token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

Calendar refreshes on connection, foreground return, manual refresh and every fifteen minutes while visible. Failed requests preserve the last successful cache and expose its age. Imported events open Google Calendar for editing. Calendar data is excluded from Planner's Drive projection.

## Daily use

- Expand Today blocks for the duration, location, source and travel basis. Unplaced items remain under **Still to place**. Start or complete meals and personal commitments to preserve their actual times when replanning.
- The morning runner supports pause, skip and undo, and survives reload. Timer zero never completes a step. An unstarted bathroom sequence waits for reopening if its full allowance crosses cleaning; an actual overrun is reported.
- In Oly, log the prescribed work as usual. Comparable completed sessions calibrate scheduling with the median of the latest five. Mark deliberate non-training interruptions for exclusion; warm-ups, queues and normal rests remain included. Declare when a measurement already includes changing.
- Resolve concurrent versions explicitly from Settings. The private revision history retains both alternatives. Independent records merge automatically.
- Set door-to-door walking overrides after measuring them. Optional pedestrian routing uses a locally stored TomTom key; four minutes for building transitions are added once. Dated facility overrides supersede the bundled hours.
- Return trips home during free gaps are opt-in. Without that preference, journeys use the last known physical location. Add a Planner commitment at the dorm when a particular return is required.

## Backups and updates

The first migration saves the original Planner settings, tasks and morning/night history before applying campus defaults. Old storage keys are retained; obsolete automatic nighttime/reading/study routines are deactivated. Use **Export pre-rebuild backup** or **Export Planner backup** in Settings. Oly keeps its own validated journal backups and exports.

Do not clear site data to update the apps. Updates install a complete cache and wait for a safe activation. Finish active sessions and save form changes before using an update banner. Each worker is scoped to its app path and cleans only its own cache namespace.
