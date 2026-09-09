# Meet

Self-hosted video meetings on Cloudflare RealtimeKit.

## Before deploying

1. **`wrangler.jsonc`** — replace `PASTE_KV_NAMESPACE_ID_HERE` with your KV
   namespace ID. Find it in the Cloudflare dashboard under
   Storage & Databases -> KV, next to `video_rooms`.

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

Then redeploy (Deployments -> Retry, or push any commit).

Add the custom domain:
Worker -> Settings -> Domains & Routes -> Add -> Custom Domain

## Verifying

- `/api/debug` should return all four values truthy
- `/` creates a meeting and returns a host link and an invite link
- `/j/<code>` joins; `?host=<key>` grants the host preset

## Routes

| Path          | What it does                          |
| ------------- | ------------------------------------- |
| `/`           | Create a meeting                      |
| `/j/<code>`   | Join a meeting                        |
| `/api/rooms`  | POST, creates meeting + stores in KV  |
| `/api/join`   | POST, mints a participant auth token  |
| `/api/debug`  | GET, checks bindings are wired up     |

## Pinning versions

`package.json` uses `latest` for the three `@cloudflare/*` packages so npm
resolves a compatible set on first install. Once everything works, open
`package-lock.json`, find the resolved version numbers, and replace `latest`
with those exact versions. This prevents a future release from breaking the
build.
