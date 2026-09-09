/**
 * Meet - Cloudflare Worker API
 *
 *   POST /api/rooms   create a meeting, store it in KV
 *   POST /api/join    mint a participant auth token
 *   GET  /api/debug   bindings + preset check (requires ?key=<ADMIN_KEY secret>)
 *   *                 static assets from the ASSETS binding
 */

const CF_API = "https://api.cloudflare.com/client/v4/accounts";

/* ---------- CHANGE THESE ---------- */
const HOST_PRESET = "Host";
const GUEST_PRESET = "Guest";
/* --------------------------------- */

// Room codes and host keys. No i/l/o, so codes can be read aloud.
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN = 8;
const HOSTKEY_LEN = 16;
const CODE_RE = new RegExp("^[" + ALPHA + "]{" + CODE_LEN + "}$");
const HOSTKEY_RE = new RegExp("^[" + ALPHA + "]{" + HOSTKEY_LEN + "}$");

const MAX_TITLE = 100;
const MAX_PASSWORD = 128;
const MAX_NAME = 60;
const MAX_BODY = 4096; // bytes. Nothing legitimate comes close.
const ROOM_TTL = 60 * 60 * 24 * 30;
const KV_CACHE_TTL = 300; // room records never change after creation
const UPSTREAM_TIMEOUT = 10000;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Stops another site iframing the meeting to trick a visitor into granting
  // camera access. Change to a CSP frame-ancestors list if you ever embed this.
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy":
    "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// The RealtimeKit UI loads blob workers, wasm and mediastream sources, so a
// CSP has to be tested against a real meeting before it is enforced. Set
// CSP = CSP_POLICY once you have done that, then confirm screenshare and
// background blur still work.
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://*.cloudflare.com wss://*.cloudflare.com blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const CSP = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/rooms")
        return request.method === "POST"
          ? await createRoom(request, env, url)
          : json({ error: "Method not allowed" }, 405);

      if (url.pathname === "/api/join")
        return request.method === "POST"
          ? await joinRoom(request, env)
          : json({ error: "Method not allowed" }, 405);

      if (url.pathname === "/api/debug") return await debugInfo(env, url);

      // Never let an unmatched /api/* path fall through to the SPA shell.
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

      return await serveAsset(request, env);
    } catch (err) {
      // Detail goes to the Worker log, not to the caller.
      console.error("unhandled", url.pathname, err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong." }, 500);
    }
  },
};

/* ---------------------------- routes ---------------------------- */

async function createRoom(request, env, url) {
  if (await limited(env.CREATE_LIMIT, clientIp(request)))
    return json({ error: "Too many meetings created. Try again in a minute." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const title = clean(body.title, MAX_TITLE) || "Meeting";
  const password = str(body.password, MAX_PASSWORD);

  const res = await cfApi(env, "/meetings", "POST", { title });
  const meetingId = res.body && res.body.data && res.body.data.id;
  if (!res.ok || !meetingId) {
    console.error("create meeting failed", res.status, JSON.stringify(res.body));
    return json({ error: "Could not create the meeting." }, 502);
  }

  const code = rand(CODE_LEN);
  const hostKey = rand(HOSTKEY_LEN);

  // Only hashes are stored, so a KV dump does not hand out host rights or
  // meeting passwords.
  const record = { meetingId, title, hostKeyHash: await sha256(hostKey) };
  if (password) {
    record.pwSalt = rand(16);
    record.pwHash = await sha256(record.pwSalt + password);
  }

  await env.ROOMS.put("room:" + code, JSON.stringify(record), {
    expirationTtl: ROOM_TTL,
  });

  const base = "https://" + url.host + "/j/" + code;
  // The host key lives in the fragment: browsers never put it in a request,
  // a Referer header, or a server log.
  return json({ guestLink: base, hostLink: base + "#host=" + hostKey });
}

async function joinRoom(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const code = str(body.code, CODE_LEN + 1);
  if (!CODE_RE.test(code)) return json({ error: "Meeting not found" }, 404);

  if (await limited(env.JOIN_LIMIT, clientIp(request) + ":" + code))
    return json({ error: "Too many attempts. Try again in a minute." }, 429);

  const room = await env.ROOMS.get("room:" + code, {
    type: "json",
    cacheTtl: KV_CACHE_TTL,
  });
  if (!room) return json({ error: "Meeting not found" }, 404);

  const supplied = str(body.password, MAX_PASSWORD);

  // A client warming up asks with no password so it can find out whether to
  // show the field. That is a normal answer, not a failure: replying 403 here
  // would put a red error in the console on every load of a protected room.
  if (!supplied && (room.pwHash || room.password))
    return json({ needsPassword: true });

  if (!(await passwordOk(room, supplied)))
    return json({ error: "Incorrect password", needsPassword: true }, 403);

  const hostKey = str(body.hostKey, HOSTKEY_LEN + 1);
  const isHost = HOSTKEY_RE.test(hostKey) && (await hostKeyOk(room, hostKey));
  const preset = isHost ? HOST_PRESET : GUEST_PRESET;

  const res = await cfApi(
    env,
    "/meetings/" + encodeURIComponent(room.meetingId) + "/participants",
    "POST",
    {
      name: clean(body.name, MAX_NAME) || "Guest",
      preset_name: preset,
      custom_participant_id: crypto.randomUUID(),
    }
  );

  const token =
    res.body && res.body.data && (res.body.data.token || res.body.data.auth_token);
  if (!res.ok || !token) {
    console.error("token failed", res.status, JSON.stringify(res.body));
    return json({ error: "Could not join the meeting." }, 502);
  }

  return json({ authToken: token, preset, isHost });
}

// Gated behind the ADMIN_KEY secret. With no secret set the route does not
// exist, so a stock deploy leaks nothing.
async function debugInfo(env, url) {
  if (!env.ADMIN_KEY || !safeEqual(env.ADMIN_KEY, url.searchParams.get("key") || ""))
    return json({ error: "Not found" }, 404);

  const presets = await cfApi(env, "/presets");
  return json({
    kv: !!env.ROOMS,
    account: !!env.CF_ACCOUNT_ID,
    app: !!env.RTK_APP_ID,
    token: !!env.RTK_API_TOKEN,
    rateLimiters: { create: !!env.CREATE_LIMIT, join: !!env.JOIN_LIMIT },
    presets: ((presets.body && presets.body.data) || []).map((p) => p.name),
    expecting: [HOST_PRESET, GUEST_PRESET],
  });
}

async function serveAsset(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.body) return res; // 204/304 carry no body to re-wrap
  const out = new Response(res.body, res);
  for (const k in SECURITY_HEADERS) out.headers.set(k, SECURITY_HEADERS[k]);
  if (CSP) out.headers.set("Content-Security-Policy", CSP);
  return out;
}

/* ---------------------------- helpers ---------------------------- */

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

// Rate limit bindings are optional: without them the Worker still runs, it
// just loses the abuse ceiling.
async function limited(binding, key) {
  if (!binding) return false;
  try {
    const { success } = await binding.limit({ key });
    return !success;
  } catch (err) {
    console.error("rate limit check failed", err);
    return false;
  }
}

async function readJson(request) {
  const len = request.headers.get("content-length");
  if (len && Number(len) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (err) {
    return null;
  }
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// Display strings reach the meeting UI and the Cloudflare API. Strip control
// characters so they cannot smuggle line breaks into either.
const clean = (v, max) =>
  [...str(v, max)]
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n > 31 && n !== 127; // drop C0 controls and DEL
    })
    .join("")
    .trim();

async function cfApi(env, path, method = "GET", body) {
  const headers = { Authorization: "Bearer " + env.RTK_API_TOKEN };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(
    CF_API + "/" + env.CF_ACCOUNT_ID + "/realtime/kit/" + env.RTK_APP_ID + path,
    {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    }
  );

  let parsed = null;
  try {
    parsed = await res.json();
  } catch (err) {
    /* upstream returned no JSON */
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function passwordOk(room, password) {
  if (room.pwHash)
    return safeEqual(room.pwHash, await sha256((room.pwSalt || "") + password));
  if (room.password) return safeEqual(room.password, password); // pre-hash records
  return true;
}

async function hostKeyOk(room, hostKey) {
  if (room.hostKeyHash) return safeEqual(room.hostKeyHash, await sha256(hostKey));
  if (room.hostKey) return safeEqual(room.hostKey, hostKey); // pre-hash records
  return false;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

const rand = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => ALPHA[b % ALPHA.length])
    .join("");

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: {
      "content-type": "application/json",
      // Auth tokens must never sit in a shared cache.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
