const CF_API = "https://api.cloudflare.com/client/v4/accounts";

/* ---------- CHANGE THESE ---------- */
const HOST_PRESET = "Host";
const GUEST_PRESET = "Guest";
/* --------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/rooms" && request.method === "POST")
        return await createRoom(request, env, url);
      if (url.pathname === "/api/join" && request.method === "POST")
        return await joinRoom(request, env);
      if (url.pathname === "/api/debug")
        return json({
          kv: typeof env.ROOMS,
          account: !!env.CF_ACCOUNT_ID,
          app: !!env.RTK_APP_ID,
          token: !!env.RTK_API_TOKEN,
        });
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};

async function createRoom(request, env, url) {
  const { title, password } = await request.json();

  const res = await fetch(
    CF_API + "/" + env.CF_ACCOUNT_ID + "/realtime/kit/" + env.RTK_APP_ID + "/meetings",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.RTK_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: title || "Meeting" }),
    }
  );
  const body = await res.json();
  if (!res.ok) return json({ error: "Create meeting failed", detail: body }, 502);

  const code = rand(8);
  const hostKey = rand(16);
  await env.ROOMS.put(
    "room:" + code,
    JSON.stringify({
      meetingId: body.data.id,
      password: password || null,
      hostKey,
      title,
    }),
    { expirationTtl: 60 * 60 * 24 * 30 }
  );

  const base = "https://" + url.host + "/j/" + code;
  return json({ guestLink: base, hostLink: base + "?host=" + hostKey });
}

async function joinRoom(request, env) {
  const { code, name, password, hostKey } = await request.json();

  const room = await env.ROOMS.get("room:" + code, "json");
  if (!room) return json({ error: "Meeting not found" }, 404);
  if (room.password && password !== room.password)
    return json({ error: "Incorrect password" }, 403);

  const preset = hostKey && hostKey === room.hostKey ? HOST_PRESET : GUEST_PRESET;

  const res = await fetch(
    CF_API +
      "/" +
      env.CF_ACCOUNT_ID +
      "/realtime/kit/" +
      env.RTK_APP_ID +
      "/meetings/" +
      room.meetingId +
      "/participants",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.RTK_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: (name || "Guest").slice(0, 60),
        preset_name: preset,
        custom_participant_id: crypto.randomUUID(),
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) return json({ error: "Token failed", detail: body }, 502);

  const token = body.data && (body.data.token || body.data.auth_token);
  if (!token) return json({ error: "No token in response", detail: body }, 502);

  return json({ authToken: token, preset });
}

const rand = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 30])
    .join("");

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
