/**
 * Meet - Cloudflare Worker API
 *
 * Public
 *   POST /api/join                  mint a participant auth token
 *   POST /api/login                 start an admin session
 *   POST /api/logout                end it
 *   GET  /api/session               who am I
 *
 * Admin only (session cookie + X-CSRF header on writes)
 *   GET    /api/meetings            list every live meeting
 *   POST   /api/rooms               create a meeting
 *   POST   /api/meetings/<code>     update title / password
 *   POST   /api/meetings/<code>/host  issue a fresh host link
 *   DELETE /api/meetings/<code>     delete
 *
 *   GET  /api/debug                 bindings + presets (needs ADMIN_KEY secret)
 *   *                               static assets from the ASSETS binding
 */

const CF_API = "https://api.cloudflare.com/client/v4/accounts";

/* ---------- CHANGE THESE ---------- */
const HOST_PRESET = "Host";
const GUEST_PRESET = "Guest";
/* --------------------------------- */

// Room codes, host keys and session tokens. No i/l/o, so codes read aloud.
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN = 8;
const HOSTKEY_LEN = 16;
const TOKEN_LEN = 32;
const CODE_RE = new RegExp("^[" + ALPHA + "]{" + CODE_LEN + "}$");
const HOSTKEY_RE = new RegExp("^[" + ALPHA + "]{" + HOSTKEY_LEN + "}$");
const TOKEN_RE = new RegExp("^[" + ALPHA + "]{" + TOKEN_LEN + "}$");

const MAX_TITLE = 100;
const MAX_PASSWORD = 128;
const MAX_NAME = 60;
const MAX_BODY = 4096; // bytes. Nothing legitimate comes close.
const ROOM_TTL = 60 * 60 * 24 * 30;
const KV_CACHE_TTL = 300; // room records only change when an admin edits one
const UPSTREAM_TIMEOUT = 10000;

const SESSION_TTL = 60 * 60 * 12; // 12 hours
const COOKIE = "meet_sess";
const MAX_USERNAME = 64;
const LIST_LIMIT = 1000;
const LEGACY_LOOKUP_CAP = 100; // pre-metadata rooms we will open to get a title

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
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/join")
        return method === "POST" ? await joinRoom(request, env) : notAllowed();

      if (path === "/api/login")
        return method === "POST" ? await login(request, env) : notAllowed();

      if (path === "/api/logout")
        return method === "POST" ? await logout(request, env) : notAllowed();

      if (path === "/api/session")
        return method === "GET" ? await session(request, env) : notAllowed();

      if (path === "/api/rooms")
        return method === "POST" ? await guard(request, env, createRoom, url) : notAllowed();

      if (path === "/api/meetings")
        return method === "GET" ? await guard(request, env, listMeetings, url) : notAllowed();

      if (path.startsWith("/api/meetings/")) {
        const rest = path.slice("/api/meetings/".length).split("/");
        const code = rest[0];
        if (!CODE_RE.test(code)) return json({ error: "Not found" }, 404);

        if (rest[1] === "host" && rest.length === 2 && method === "POST")
          return await guard(request, env, (rq, e, u, who) => rotateHost(e, u, code), url);

        if (rest.length !== 1) return json({ error: "Not found" }, 404);
        if (method === "POST")
          return await guard(request, env, (rq, e, u) => updateMeeting(rq, e, code), url);
        if (method === "DELETE")
          return await guard(request, env, (rq, e) => deleteMeeting(e, code), url);
        return notAllowed();
      }

      if (path === "/api/debug") return await debugInfo(env, url);

      // Never let an unmatched /api/* path fall through to the SPA shell.
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

      return await serveAsset(request, env);
    } catch (err) {
      // Detail goes to the Worker log, not to the caller.
      console.error("unhandled", path, err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong." }, 500);
    }
  },
};

/* ------------------------------ auth ------------------------------ */

// No cookie means no KV read at all, so the public pages stay cheap.
async function currentAdmin(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  const sess = await env.ROOMS.get("sess:" + token, { type: "json" });
  return sess && sess.username ? sess.username : null;
}

// Every admin route goes through here: session, then CSRF on writes.
async function guard(request, env, handler, url) {
  const who = await currentAdmin(request, env);
  if (!who) return json({ error: "Not signed in" }, 401);

  // A cross-site form post cannot set a custom header, and a cross-site fetch
  // that tries is stopped by the preflight we never answer. Belt and braces
  // alongside SameSite=Strict.
  if (request.method !== "GET" && request.headers.get("X-CSRF") !== "1")
    return json({ error: "Bad request" }, 400);

  return await handler(request, env, url, who);
}

async function login(request, env) {
  if (await limited(env.LOGIN_LIMIT, clientIp(request)))
    return json({ error: "Too many attempts. Try again in a minute." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const expectedUser = str(env.ADMIN_USERNAME, MAX_USERNAME).trim();
  const expectedPass = str(env.ADMIN_PASSWORD, MAX_PASSWORD);

  // With no secrets set there is no admin, so nothing can sign in. Without
  // this check an empty password would match an unset secret.
  if (!expectedUser || !expectedPass) {
    console.error("ADMIN_USERNAME / ADMIN_PASSWORD secrets are not set");
    return json({ error: "Incorrect username or password" }, 401);
  }

  const username = str(body.username, MAX_USERNAME).trim();
  const password = str(body.password, MAX_PASSWORD);

  // Compare digests rather than the raw strings. They are the same length
  // every time, so the comparison cannot leak how long the real password is,
  // and both halves are always evaluated so the timing does not say which one
  // was wrong.
  const userOk = safeEqual(
    await sha256(username.toLowerCase()),
    await sha256(expectedUser.toLowerCase())
  );
  const passOk = safeEqual(await sha256(password), await sha256(expectedPass));

  if (!userOk || !passOk)
    return json({ error: "Incorrect username or password" }, 401);

  const token = rand(TOKEN_LEN);
  // Store the configured spelling, not whatever case they typed.
  await env.ROOMS.put(
    "sess:" + token,
    JSON.stringify({ username: expectedUser, createdAt: Date.now() }),
    { expirationTtl: SESSION_TTL }
  );

  return json(
    { username: expectedUser },
    200,
    { "set-cookie": cookie(token, SESSION_TTL) }
  );
}

async function logout(request, env) {
  const token = readCookie(request, COOKIE);
  if (token && TOKEN_RE.test(token)) await env.ROOMS.delete("sess:" + token);
  return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
}

async function session(request, env) {
  const who = await currentAdmin(request, env);
  return json({ authed: !!who, username: who || null });
}

/* ---------------------------- meetings ---------------------------- */

async function createRoom(request, env, url) {
  // Creation is behind the login now, so this is only a ceiling on a
  // compromised or shared admin session.
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
  const now = Date.now();

  // Only hashes are stored, so a KV dump does not hand out host rights or
  // meeting passwords.
  const record = {
    meetingId,
    title,
    createdAt: now,
    exp: Math.floor(now / 1000) + ROOM_TTL,
    hostKeyHash: await sha256(hostKey),
  };
  if (password) {
    record.pwSalt = rand(16);
    record.pwHash = await sha256(record.pwSalt + password);
  }

  await putRoom(env, code, record);

  return json({ code, ...links(url, code, hostKey) });
}

// One KV list call renders the whole dashboard. The title, creation time and
// password flag ride along as key metadata, so there is no read per row.
async function listMeetings(request, env, url) {
  const listed = await env.ROOMS.list({ prefix: "room:", limit: LIST_LIMIT });

  const meetings = [];
  const legacy = [];

  for (const k of listed.keys) {
    const code = k.name.slice(5);
    if (!CODE_RE.test(code)) continue;
    const m = k.metadata;
    if (m && m.t !== undefined) {
      meetings.push({
        code,
        title: m.t,
        createdAt: m.c || null,
        hasPassword: !!m.p,
        expiresAt: k.expiration || null,
        guestLink: links(url, code).guestLink,
      });
    } else {
      legacy.push({ code, name: k.name, expiresAt: k.expiration || null });
    }
  }

  // Rooms created before metadata existed. Opened in parallel, capped, and
  // they age out on their own within 30 days.
  const head = legacy.slice(0, LEGACY_LOOKUP_CAP);
  const rows = await Promise.all(
    head.map((l) => env.ROOMS.get(l.name, { type: "json", cacheTtl: KV_CACHE_TTL }))
  );
  head.forEach((l, i) => {
    const r = rows[i] || {};
    meetings.push({
      code: l.code,
      title: r.title || "(untitled)",
      createdAt: r.createdAt || null,
      hasPassword: !!(r.pwHash || r.password),
      expiresAt: l.expiresAt,
      guestLink: links(url, l.code).guestLink,
    });
  });

  for (const l of legacy.slice(LEGACY_LOOKUP_CAP)) {
    meetings.push({
      code: l.code,
      title: "(untitled)",
      createdAt: null,
      hasPassword: false,
      expiresAt: l.expiresAt,
      guestLink: links(url, l.code).guestLink,
    });
  }

  meetings.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ meetings, truncated: !listed.list_complete });
}

async function updateMeeting(request, env, code) {
  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const room = await env.ROOMS.get("room:" + code, { type: "json" });
  if (!room) return json({ error: "Meeting not found" }, 404);

  if (body.title !== undefined) room.title = clean(body.title, MAX_TITLE) || "Meeting";

  // Absent means leave it alone; empty string means remove the password.
  if (body.password !== undefined) {
    const pw = str(body.password, MAX_PASSWORD);
    delete room.password; // drop any pre-hash field while we are here
    if (pw) {
      room.pwSalt = rand(16);
      room.pwHash = await sha256(room.pwSalt + pw);
    } else {
      delete room.pwSalt;
      delete room.pwHash;
    }
  }

  await putRoom(env, code, room);
  return json({ ok: true, title: room.title, hasPassword: !!room.pwHash });
}

// The host key is only ever stored as a hash, so it cannot be shown again
// later. Issuing a new one is how you hand out host access, and it revokes
// whatever link was in circulation before.
async function rotateHost(env, url, code) {
  const room = await env.ROOMS.get("room:" + code, { type: "json" });
  if (!room) return json({ error: "Meeting not found" }, 404);

  const hostKey = rand(HOSTKEY_LEN);
  room.hostKeyHash = await sha256(hostKey);
  delete room.hostKey; // drop any pre-hash field

  await putRoom(env, code, room);
  return json(links(url, code, hostKey));
}

async function deleteMeeting(env, code) {
  await env.ROOMS.delete("room:" + code);
  return json({ ok: true });
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

  // A signed-in admin owns every meeting: host preset, no password, no key.
  const admin = await currentAdmin(request, env);

  if (!admin) {
    const supplied = str(body.password, MAX_PASSWORD);

    // A client warming up asks with no password so it can find out whether to
    // show the field. That is a normal answer, not a failure: replying 403
    // here would put a red error in the console on every load of a protected
    // room.
    if (!supplied && (room.pwHash || room.password))
      return json({ needsPassword: true });

    if (!(await passwordOk(room, supplied)))
      return json({ error: "Incorrect password", needsPassword: true }, 403);
  }

  const hostKey = str(body.hostKey, HOSTKEY_LEN + 1);
  const isHost =
    !!admin || (HOSTKEY_RE.test(hostKey) && (await hostKeyOk(room, hostKey)));
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

  return json({ authToken: token, preset, isHost, title: room.title || null });
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
    adminUser: !!env.ADMIN_USERNAME,
    adminPassword: !!env.ADMIN_PASSWORD,
    rateLimiters: {
      create: !!env.CREATE_LIMIT,
      join: !!env.JOIN_LIMIT,
      login: !!env.LOGIN_LIMIT,
    },
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

// Writing a room always refreshes the listing metadata and keeps whatever is
// left of the original 30 days, so editing a meeting does not extend its life.
function putRoom(env, code, record) {
  const remaining = record.exp
    ? record.exp - Math.floor(Date.now() / 1000)
    : ROOM_TTL;
  return env.ROOMS.put("room:" + code, JSON.stringify(record), {
    expirationTtl: Math.max(60, Math.min(remaining, ROOM_TTL)),
    metadata: {
      t: record.title || "Meeting",
      c: record.createdAt || null,
      p: record.pwHash || record.password ? 1 : 0,
    },
  });
}

function links(url, code, hostKey) {
  const base = url.origin + "/j/" + code;
  const out = { guestLink: base };
  // The host key lives in the fragment: browsers never put it in a request,
  // a Referer header, or a server log.
  if (hostKey) out.hostLink = base + "#host=" + hostKey;
  return out;
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

const cookie = (token, maxAge) =>
  COOKIE +
  "=" +
  token +
  "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" +
  maxAge;

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

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
  return hex(new Uint8Array(d));
}

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

const rand = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => ALPHA[b % ALPHA.length])
    .join("");

const notAllowed = () => json({ error: "Method not allowed" }, 405);

const json = (o, status = 200, extra) =>
  new Response(JSON.stringify(o), {
    status,
    headers: {
      "content-type": "application/json",
      // Auth tokens must never sit in a shared cache.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(extra || {}),
    },
  });
