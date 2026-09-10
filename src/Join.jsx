import { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  useRealtimeKitClient,
  initRTKMedia,
} from "@cloudflare/realtimekit-react";
import { COMPANY, api } from "./ui.js";
import { Shell, TopBar, Footer, Waiting, LockIcon, ArrowIcon } from "./chrome.jsx";

// The meeting and everything the SDK's UI kit drags in.
const Meeting = lazy(() => import("./Meeting.jsx"));

// How long to let the camera and microphone warm up before giving up on them
// and connecting anyway.
//
// This number matters more than it looks. The SDK's init() awaits getUserMedia
// internally, so if we hand it audio/video while a permission prompt is still
// sitting unanswered, the whole join stalls until the visitor clicks Allow.
// Instead we wait a beat: if the browser already has permission it resolves in
// a few hundred ms and they get a live preview, and if a prompt is open we stop
// waiting and connect without devices. They land on the setup screen either
// way, and the camera switches itself on if permission arrives later.
const MEDIA_WAIT_MS = 2500;

// tracing:false stops the SDK shipping OpenTelemetry logs. That endpoint sends
// CORS headers Firefox complains about, once every few seconds, for telemetry
// we never look at. devTools.logs:false keeps its internal logger off the
// console too.
const SDK_MODULES = {
  tracing: false,
  devTools: { logs: false, logLevel: "off" },
};

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
    if (n) localStorage.setItem(NAME_KEY, n);
  } catch (e) {
    /* private mode */
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postJoin = (payload) => api("/api/join", { method: "POST", body: payload });

export default function Join() {
  const [, initMeeting] = useRealtimeKitClient();
  const [client, setClient] = useState(null);
  const [needsPw, setNeedsPw] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);

  const [slow, setSlow] = useState(false);

  const media = useRef(null);
  const started = useRef(false);
  const clientRef = useRef(null);
  const usedWarmMedia = useRef(false);

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
    const ui = import("./Meeting.jsx");

    // Fired now so the permission prompt appears while the token request is in
    // flight. Nothing ever blocks on this promise; it resolves to a media
    // handler we can hand the SDK, or to null.
    media.current = initRTKMedia({ audio: true, video: true })
      .catch((e) => {
        // No camera on this machine: still try for the microphone. A denied
        // permission is not retried, that would only prompt a second time.
        if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError"))
          return initRTKMedia({ audio: true, video: false });
        throw e;
      })
      .then(
        (h) => {
          log("media ready", Math.round(performance.now() - t0), "ms");
          return h;
        },
        (e) => {
          log("media unavailable:", e && e.name);
          return null;
        }
      );

    // Cold DNS + TLS to the meeting edge can take a while, Safari especially.
    // After this long, say so, so a slow join does not read as a broken one.
    const slowTimer = setTimeout(() => setSlow(true), 6000);

    start("", ui, t0);
    return () => clearTimeout(slowTimer);
  }, []);

  async function start(password, uiPromise, t0) {
    setBusy(true);
    setErr("");

    if (!code) {
      setErr("No meeting code in the URL.");
      setBusy(false);
      return;
    }

    try {
      const d = await postJoin({ code, hostKey, name: savedName(), password });

      if (d.body.needsPassword) {
        setNeedsPw(true);
        if (password) setErr(d.body.error || "Incorrect password");
        setBusy(false);
        return;
      }
      if (d.status === 404) {
        setErr("That meeting link is not valid.");
        setBusy(false);
        return;
      }
      if (!d.body.authToken) {
        setErr(d.body.error || "Could not join this meeting.");
        setBusy(false);
        return;
      }

      // The password was right. Drop the gate now rather than when the whole
      // connect finishes: minting the token is the fast part, opening the
      // meeting socket is not, and on a cold connection that left the button
      // sitting on "Checking..." for long enough to look broken.
      setNeedsPw(false);

      const c = await connect(d.body.authToken, password);
      if (!c) return;

      if (uiPromise) await uiPromise;
      clientRef.current = c;

      // Connected without devices because a prompt was still open. If the
      // visitor allows it after all, switch them on rather than making them
      // hunt for the buttons. Attached after the client exists, and fires
      // straight away if the promise has already settled.
      if (!usedWarmMedia.current)
        media.current.then((h) => {
          if (!h) return;
          log("permission arrived late, enabling devices");
          c.self.enableAudio().catch(() => {});
          c.self.enableVideo().catch(() => {});
        });

      // Whatever name they settle on in the setup screen is worth keeping, so
      // the next meeting starts with it filled in.
      try {
        c.self.on("roomJoined", () => rememberName(c.self.name));
      } catch (e) {
        /* older SDK without the event */
      }

      setClient(c);
      log("ready in", Math.round(performance.now() - (t0 || 0)), "ms");
    } catch (e) {
      setErr("Error: " + (e && e.message ? e.message : e));
      console.error(e);
      setBusy(false);
    }
  }

  async function connect(token, password) {
    // Never await the media promise on its own: see MEDIA_WAIT_MS.
    const handler = await Promise.race([media.current, sleep(MEDIA_WAIT_MS)]);

    const withMedia = !!handler;
    if (!withMedia) log("connecting without devices, they can be enabled on the setup screen");

    const opts = {
      authToken: token,
      defaults: withMedia
        ? { audio: true, video: true, mediaHandler: handler }
        : { audio: false, video: false },
      modules: SDK_MODULES,
    };

    let c = await initMeeting(opts).catch((e) => {
      log("init failed:", e && e.message);
      return null;
    });

    // A token can go stale while someone sits on a permission prompt, and a
    // stale one fails at init. Mint a fresh one and try once more before
    // showing an error.
    if (!c) {
      log("retrying with a fresh token");
      const again = await postJoin({ code, hostKey, name: savedName(), password });
      if (again.body.authToken)
        c = await initMeeting({ ...opts, authToken: again.body.authToken }).catch(
          () => null
        );
    }

    if (!c) {
      setErr("Could not connect to the meeting. Reload to try again.");
      setBusy(false);
      return null;
    }

    usedWarmMedia.current = withMedia;
    return c;
  }

  if (client)
    return (
      <Suspense fallback={<Waiting text="Opening the room..." />}>
        <Meeting client={client} />
      </Suspense>
    );

  if (needsPw)
    return (
      <Shell center bar={<TopBar />}>
        <div className="narrow">
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              <LockIcon style={{ verticalAlign: "-1px", marginRight: 6 }} />
              Locked room
            </div>
            <div className="card-title" style={{ fontSize: 22, marginBottom: 6 }}>
              This meeting has a password
            </div>
            <p className="muted" style={{ marginBottom: 18 }}>
              Ask the host for it if you do not have one.
            </p>

            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) start(pw);
              }}
            >
              <label className="field-label" htmlFor="pw">
                Meeting password
              </label>
              <input
                id="pw"
                className="field"
                type="password"
                placeholder="Meeting password"
                autoComplete="off"
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Checking..." : "Continue"}
                {busy ? null : <ArrowIcon />}
              </button>
            </form>

            <div className="err" style={{ marginTop: 14 }}>
              {err}
            </div>
          </div>
          <Footer />
        </div>
      </Shell>
    );

  // Connecting, or connecting went wrong. Same card either way.
  return (
    <Shell center bar={<TopBar />}>
      <div className="narrow">
        <div className="card" style={{ textAlign: "center" }}>
          {err ? (
            <>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                {COMPANY} Meet
              </div>
              <div className="card-title" style={{ fontSize: 20, marginBottom: 10 }}>
                We could not open that room
              </div>
              <div className="err">{err}</div>
              <a className="btn btn-ghost" href="/" style={{ marginTop: 20 }}>
                Try another code
              </a>
            </>
          ) : (
            <>
              <div className="spinner" />
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                {COMPANY} Meet
              </div>
              <div className="muted">Connecting you to the room...</div>
              {slow && (
                <div className="hint" style={{ marginTop: 10 }}>
                  Still going. The first connection from a browser is the slow
                  one; the next will be quicker.
                </div>
              )}
            </>
          )}
        </div>
        <Footer />
      </div>
    </Shell>
  );
}
