# Meet

Self-hosted video meetings on Cloudflare RealtimeKit.

- `/` and `/new` — public page: enter an 8-character meeting code, or sign in
- `/j/<code>` — join a meeting
- `/admin` — create meetings and manage the existing ones

## Before deploying

1. **`wrangler.jsonc`** — the KV namespace ID is already filled in. If you move
   to a different account, replace it with the ID from the Cloudflare dashboard
   under Storage & Databases -> KV, next to `video_rooms`.

2. **`worker/index.js`** — `HOST_PRESET` and `GUEST_PRESET` must match your
   preset names exactly (case sensitive). Check them under
   Realtime -> RealtimeKit -> Presets.

3. **`src/ui.js`** — set `COMPANY` and `BRAND` to your own values.

## Deploying

Connect this repo in the Cloudflare dashboard:
Compute (Workers) -> Create -> Import a repository.

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: leave blank

## After the first deploy

Add three **secrets** (type Secret, not plain variable), under
Worker -> Settings -> Variables and Secrets -> Add:

| Name             | Value                                              |
| ---------------- | -------------------------------------------------- |
| `RTK_API_TOKEN`  | your Cloudflare API token with the Realtime permission |
| `ADMIN_USERNAME` | whatever you want to sign in as                    |
| `ADMIN_PASSWORD` | a long password you choose                         |

Optionally add a fourth, `ADMIN_KEY`, to switch on `/api/debug`. Without it that
route returns 404, which is what you want in normal operation.

Then redeploy (Deployments -> Retry, or push any commit).

Add the custom domain:
Worker -> Settings -> Domains & Routes -> Add -> Custom Domain

## The admin login

The username and password are the `ADMIN_USERNAME` and `ADMIN_PASSWORD` secrets
above. There is no sign-up page and no bootstrap route, so there is nothing to
attack, and nothing to set up beyond adding those two secrets in the dashboard.

- **Change the password:** edit the secret. It takes effect on the next sign-in;
  existing sessions keep working until they expire.
- **Lock everyone out now:** delete the secrets. With either one missing, no
  sign-in can succeed, including an empty one.
- The username is matched case-insensitively; the password is exact.

Sessions are KV entries under `sess:<token>` with a 12 hour expiry. Deleting one
signs that browser out immediately:

```bash
npx wrangler kv key list --remote --binding ROOMS --prefix "sess:"
npx wrangler kv key delete --remote --binding ROOMS "sess:<token>"
```

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill it
in. That file is gitignored.

## What the admin can do

Everything on `/admin`:

- **Create** a meeting, with an optional password. Both links are shown once.
- **See** every live meeting: title, code, when it was made, when it expires,
  and whether it has a password.
- **Join as host** — a signed-in admin gets the host preset on any meeting, and
  skips the password. No host key needed.
- **Copy invite** — the guest link.
- **Edit** — rename, add, change or remove the password.
- **New host link** — issues a fresh host key. Host keys are only ever stored
  as a hash, so an old one cannot be shown again; generating a new link is also
  how you revoke the previous one.
- **Delete** — removes the KV record, so the link stops working immediately.
  The meeting object on Cloudflare's side is left alone; it is unreachable
  without the record.

Creating a meeting used to be open to anyone who found the site. It is now
behind this login.

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

- `/` shows the code entry page
- signing in lands on `/admin`
- `/api/debug?key=<ADMIN_KEY>` checks bindings and lists your preset names

Add `?debug=1` to any join URL to print join timings to the console. Without it
the app logs nothing.

## Routes

| Path                          | Method | Who    | What                          |
| ----------------------------- | ------ | ------ | ----------------------------- |
| `/`, `/new`                   | GET    | anyone | Enter a code, or sign in      |
| `/j/<code>`                   | GET    | anyone | Join a meeting                |
| `/admin`                      | GET    | admin  | Dashboard                     |
| `/api/join`                   | POST   | anyone | Mint a participant token      |
| `/api/login`                  | POST   | anyone | Start a session               |
| `/api/logout`                 | POST   | anyone | End it                        |
| `/api/session`                | GET    | anyone | Am I signed in                |
| `/api/meetings`               | GET    | admin  | List every meeting            |
| `/api/rooms`                  | POST   | admin  | Create a meeting              |
| `/api/meetings/<code>`        | POST   | admin  | Update title / password       |
| `/api/meetings/<code>`        | DELETE | admin  | Delete                        |
| `/api/meetings/<code>/host`   | POST   | admin  | Issue a fresh host link       |
| `/api/debug`                  | GET    | key    | Bindings + presets            |

Writes require an `X-CSRF: 1` header on top of the session cookie. A cross-site
form post cannot set a header, and a cross-site `fetch` that tries is stopped by
a preflight the Worker never answers, so CSRF is not reachable. The cookie is
`HttpOnly; Secure; SameSite=Strict` as well.

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

Set `PREWARM = false` in `src/Join.jsx` to go back to doing all of it on click.

Rooms with a password skip the prewarm, because there is nothing to mint a
token with until the password is entered. The password field only appears when
the room actually has one.

The RealtimeKit SDK is a lazy chunk, so `/` and `/new` never download it. Those
pages load about 48 kB gzipped; the SDK arrives only on `/j/<code>`.

The dashboard renders from a single KV `list` call. Title, creation time and
the password flag are stored as key metadata, which `list` returns inline, so
showing a hundred meetings costs one read rather than a hundred and one.

## Rate limits

`wrangler.jsonc` binds three rate limiters, all per IP per minute: 10 meeting
creations, 20 join attempts, 8 sign-in attempts.

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
