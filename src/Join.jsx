import { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  useRealtimeKitClient,
  RealtimeKitProvider,
  initRTKMedia,
} from "@cloudflare/realtimekit-react";
import {
  COMPANY,
  api,
  centred,
  card,
  narrow,
  brandStyle,
  input,
  button,
  errStyle,
  muted,
  label,
  stack,
} from "./ui.js";

const RtkMeeting = lazy(() =>
  import("@cloudflare/realtimekit-react-ui").then((m) => ({
    default: m.RtkMeeting,
  }))
);

// Mint the token and initialise the SDK while the user is still typing their
// name, so clicking Join is near-instant instead of a ~3s wait. The trade-off:
// the camera is acquired on page load and held (the indicator light stays on),
// and a participant token is minted even if they never join. Set to false to
// do all of it on click instead.
const PREWARM = true;

// tracing:false stops the SDK shipping OpenTelemetry logs. That endpoint sends
// CORS headers Firefox complains about, once every few seconds, for telemetry
// we never look at. devTools.logs:false keeps its internal logger off the
// console too.
const SDK_MODULES = {
  tracing: false,
  devTools: { logs: false, logLevel: "off" },
};

const MEDIA = { audio: true, video: true };

// Timing and diagnostics only when asked for: add ?debug=1 to the URL.
const DEBUG = new URLSearchParams(location.search).has("debug");
const log = (...a) => {
  if (DEBUG) console.log(...a);
};

const NAME_KEY = "meet:name";
const savedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch (e) {
    return "";
  }
};
const rememberName = (n) => {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch (e) {
    /* private mode */
  }
};

const postJoin = (payload) => api("/api/join", { method: "POST", body: payload });

export default function Join() {
  const [, initMeeting] = useRealtimeKitClient();
  const [client, setClient] = useState(null);
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [needsPw, setNeedsPw] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(savedName);
  const [pw, setPw] = useState("");

  const warm = useRef({ ui: null, media: Promise.resolve(), ready: null });
  const started = useRef(false);

  const parts = location.pathname.split("/");
  const code = parts[parts.indexOf("j") + 1] || "";
  // Newer host links carry the key in the fragment, which browsers never put
  // in a request or a Referer header. Older ?host= links still work.
  const hostKey =
    new URLSearchParams(location.hash.slice(1)).get("host") ||
    new URLSearchParams(location.search).get("host") ||
    "";

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;

    const t0 = performance.now();

    // The meeting UI is the largest chunk on the page. Start it immediately.
    const ui = import("@cloudflare/realtimekit-react-ui");

    // Acquires the devices once and hands the tracks to the SDK, instead of
    // the old grab-then-stop warm-up that made init re-acquire them.
    const media = initRTKMedia(MEDIA)
      .catch((e) => {
        // No camera on this machine: still warm the microphone. A denied
        // permission is not retried, that would only prompt a second time.
        if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError"))
          return initRTKMedia({ audio: true, video: false });
        throw e;
      })
      .then(
        () => log("media ready", Math.round(performance.now() - t0), "ms"),
        (e) => log("media warm-up skipped:", e && e.name)
      );

    warm.current = { ui, media, ready: null };
    if (!PREWARM || !code) return;

    // The first attempt carries no password. The worker answers a protected
    // room with needsPassword instead of a token, which is what decides
    // whether to show the password field at all.
    warm.current.ready = (async () => {
      const d = await postJoin({ code, hostKey, name: savedName(), password: "" });

      if (d.body.needsPassword) {
        setNeedsPw(true);
        return null;
      }
      if (d.status === 404) {
        setErr("That meeting link is not valid.");
        return null;
      }
      if (!d.body.authToken) return null;

      await media; // tracks first, so init adopts them
      const c = await initMeeting({
        authToken: d.body.authToken,
        defaults: MEDIA,
        modules: SDK_MODULES,
      });
      if (!c) return null;

      log("prewarm ready", Math.round(performance.now() - t0), "ms");
      return { client: c, isHost: !!d.body.isHost };
    })().catch((e) => {
      log("prewarm failed:", e && e.message);
      return null; // the click path will do it from scratch
    });
  }, []);

  async function coldJoin() {
    const d = await postJoin({ code, hostKey, name, password: pw });

    if (d.body.needsPassword) {
      setNeedsPw(true);
      setErr(d.body.error || "This meeting needs a password.");
      return null;
    }
    if (!d.body.authToken) {
      setErr(d.body.error || "Could not join");
      return null;
    }

    await warm.current.media;
    const c = await initMeeting({
      authToken: d.body.authToken,
      defaults: MEDIA,
      modules: SDK_MODULES,
    });
    if (!c) {
      setErr("Could not start the meeting client.");
      return null;
    }
    return { client: c, isHost: !!d.body.isHost };
  }

  async function go(e) {
    if (e) e.preventDefault();
    if (busy) return;
    if (!code) {
      setErr("No meeting code in the URL.");
      return;
    }

    setBusy(true);
    setErr("");
    const t0 = performance.now();

    try {
      const session =
        (warm.current.ready && (await warm.current.ready)) || (await coldJoin());
      if (!session) {
        setBusy(false);
        return;
      }

      // The prewarmed token was minted before we knew the name, so set the
      // display name now. It is read when the client actually joins the room.
      const trimmed = name.trim();
      if (trimmed) {
        rememberName(trimmed);
        try {
          session.client.self.setName(trimmed);
        } catch (e2) {
          log("setName failed:", e2 && e2.message);
        }
      }

      await warm.current.ui;

      setClient(session.client);
      setIsHost(session.isHost);
      setJoined(true);
      log("click to meeting UI:", Math.round(performance.now() - t0), "ms");
    } catch (e2) {
      setErr("Error: " + (e2 && e2.message ? e2.message : e2));
      console.error(e2);
      setBusy(false);
    }
  }

  if (joined && client) {
    return (
      <RealtimeKitProvider value={client}>
        <Suspense fallback={<div style={centred}>Loading meeting...</div>}>
          <RtkMeeting
            meeting={client}
            showSetupScreen={isHost}
            style={{ height: "100vh", width: "100vw" }}
          />
        </Suspense>
      </RealtimeKitProvider>
    );
  }

  return (
    <div style={centred}>
      <div style={{ ...card, ...narrow }}>
        <div style={brandStyle}>{COMPANY}</div>
        <form onSubmit={go} style={stack}>
          <label style={label} htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            style={input}
            placeholder="Your name"
            autoComplete="name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {needsPw && (
            <input
              style={input}
              type="password"
              placeholder="Meeting password"
              autoComplete="off"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          )}
          <button style={button} type="submit" disabled={busy}>
            {busy ? "Joining..." : "Join meeting"}
          </button>
        </form>
        <div style={{ ...errStyle, marginTop: 12 }}>{err}</div>
        <div style={{ ...muted, marginTop: 4, textAlign: "center" }}>
          Code {code}
        </div>
      </div>
    </div>
  );
}
