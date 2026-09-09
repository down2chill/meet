# Meet

Self-hosted video meetings on Cloudflare RealtimeKit.

## Before deploying

1. **`wrangler.jsonc`** — the KV namespace ID is already filled in. If you move
   to a different account, replace it with the ID from the Cloudflare dashboard
   under Storage & Databases -> KV, next to `video_rooms`.

2. **`worker/index.js`** — `HOST_PRESET` and `GUEST_PRESET` must match your
   preset names exactly (case sensitive). Check them under
   Realtime -> RealtimeKit -> Presets.

3. **`src/App.jsx`** — set `COMPANY` and `BRAND` to your own values.

## Deploying

Connect this repo in the Cloudflare dashboard:
Compute (Workers) -> Create -> Import a repository.

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: leave blank

## After the first deploy

Add the API token as a **secret** (not a plain variable):

Worker -> Settings -> Variables and Secrets -> Add -> type Secret
- Name: `RTK_API_TOKEN`
- Value: your Cloudflare API token with the Realtime permission

Optionally add a second secret, `ADMIN_KEY`, to switch on `/api/debug`. Without
it that route returns 404, which is what you want in normal operation.

Then redeploy (Deployments -> Retry, or push any commit).

Add the custom domain:
Worker -> Settings -> Domains & Routes -> Add -> Custom Domain

## Turn off the Cloudflare Web Analytics beacon

If Web Analytics is enabled for this hostname, Cloudflare injects
`static.cloudflareinsights.com/beacon.min.js` into every HTML response at the
edge, after the Worker has run. Firefox blocks it via Enhanced Tracking
Protection and logs three console errors per page load (CORS, ETP, and an
integrity-hash mismatch, because the blocked file hashes as empty).

Nothing in this repo loads it, so it cannot be removed from the code. Turn it
off in the dashboard: Web Analytics -> your site -> Manage site -> disable
automatic setup. Or leave it: the errors are cosmetic and the site works.

## Verifying

- `/` creates a meeting and returns a host link and an invite link
- `/j/<code>` joins; `#host=<key>` grants the host preset
- `/api/debug?key=<ADMIN_KEY>` checks bindings and lists your preset names

Add `?debug=1` to any join URL to print join timings to the console. Without it
the app logs nothing.

## Routes

| Path          | What it does                             |
| ------------- | ---------------------------------------- |
| `/`           | Create a meeting                         |
| `/j/<code>`   | Join a meeting                           |
| `/api/rooms`  | POST, creates meeting + stores in KV     |
| `/api/join`   | POST, mints a participant auth token     |
| `/api/debug`  | GET, bindings + presets, needs ADMIN_KEY |

## How joining is kept fast

The join page does the slow work up front, while the visitor is still typing
their name:

- the meeting UI bundle starts downloading on first render
- `initRTKMedia` acquires the camera and microphone once and hands those exact
  tracks to the SDK, so it never has to re-acquire them
- a participant token is minted and the SDK is initialised in the background

Clicking **Join** then only has to set the display name and mount the UI. Two
consequences worth knowing about:

- the camera indicator light comes on while the name is being typed
- a token is minted even for someone who never clicks Join, so they appear in
  the meeting's participant list as `Guest`

Set `PREWARM = false` in `src/App.jsx` to go back to doing all of it on click.

Rooms with a password skip the prewarm, because there is nothing to mint a
token with until the password is entered. The password field only appears when
the room actually has one.

## Rate limits

`wrangler.jsonc` binds two rate limiters: 10 meeting creations and 20 join
attempts per IP per minute. These cap what an unauthenticated visitor can spend
on your Cloudflare account, and stop a meeting password being brute forced.

The Worker degrades gracefully if you delete that block; it just stops limiting.

## Security headers

`public/_headers` sets them for static assets, and `worker/index.js` sets the
same list on anything the Worker serves. `X-Frame-Options: SAMEORIGIN` is the
important one: without it another site could iframe a meeting and trick a
visitor into granting camera access.

`worker/index.js` also carries a `CSP_POLICY` that is **not** applied. The
RealtimeKit UI loads blob workers, wasm and mediastream sources, so test it
against a real meeting (screenshare and background blur especially) before
setting `CSP = CSP_POLICY`.

## Pinning versions

The three `@cloudflare/*` packages are pinned to 2.0.2. Bump them deliberately
and re-test a real call; the SDK options this app relies on (`modules.tracing`,
`initRTKMedia`, `self.setName`) are not covered by semver promises.
