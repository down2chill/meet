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
- **Delete** — removes the KV record, so the link stops working. The meeting
  object on Cloudflare's side is left alone; it is unreachable without the
  record. Allow up to a minute: an edge that already served that meeting can
  keep its cached copy for `KV_CACHE_TTL`, which is set to KV's 60 second
  minimum. Anyone already in the call stays in it.

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

Opening `/j/<code>` goes straight to the meeting's setup screen: name, camera
preview, microphone and device pickers, then Join. There is no separate name
form in front of it, because the setup screen already asks for one.

On load, and all at once: the meeting UI chunk starts downloading, the camera
and microphone warm up, and a participant token is minted. Then the SDK
connects and the setup screen appears.

**Nothing ever waits on a permission prompt.** This is the part that is easy to
get wrong. The SDK's `init()` awaits `getUserMedia` internally, so handing it
`audio: true, video: true` while a prompt is still open stalls the entire join
until the visitor clicks Allow — they sit on a spinner with no idea that the
thing blocking them is the dialog at the top of their screen.

So the warm-up gets `MEDIA_WAIT_MS` (2.5s) and no more:

- permission already granted: it resolves in a few hundred ms, and the SDK is
  handed those exact tracks rather than re-acquiring them
- a prompt is open, or devices are missing or blocked: we stop waiting and
  connect with `audio: false, video: false`

Either way the setup screen appears. If permission arrives late, the camera and
microphone switch themselves on. If it is refused, the buttons on the setup
screen are there to try again.

A token that has gone stale while someone sat on a prompt fails at `init()`, so
a fresh one is minted and it retries once before showing an error.

Rooms with a password show a password field first, since there is no token to
mint until it is entered.

### Why the visitor may be asked for the camera on every reload

Chrome and Firefox remember a granted camera permission per site, so normally
this happens once. Two cases where it does not:

- **private / incognito windows** discard permissions when the window closes,
  and some builds re-ask on every page load
- **Safari** defaults camera and microphone to "Ask" per site, so it prompts
  each session unless the visitor sets Allow in Settings for that site

Neither is something the page can change. The important part is that being
asked no longer holds up the join.

The RealtimeKit SDK is a lazy chunk, so `/` and `/new` never download it. Those
pages load about 48 kB gzipped; the SDK arrives only on `/j/<code>`.

The dashboard renders from a single KV `list` call. Title, creation time and
the password flag are stored as key metadata, which `list` returns inline, so
showing a hundred meetings costs one read rather than a hundred and one.

After a create, edit or delete the dashboard updates its own list from the
response instead of re-fetching. That is one fewer round trip, and it avoids a
race: KV's list index trails writes by a few seconds, so a re-fetch can still
show a meeting you just deleted, or miss one you just made. Use **Refresh** if
you want to re-read from KV.

## A KV consistency caveat

Editing the same meeting twice inside 60 seconds can lose the first change.
Each edit reads the record, changes a field and writes it back, and that read
can be served from a cache that has not yet seen the previous write. Changing
the title and the password in one save is fine, because that is a single
read-modify-write. This is inherent to Workers KV, not something the app can
work around.

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
`initRTKMedia`, `defaults.mediaHandler`, and the setup screen's own name field)
are not covered by semver promises.
