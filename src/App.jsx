import { useState, lazy, Suspense } from "react";
import {
  useRealtimeKitClient,
  RealtimeKitProvider,
} from "@cloudflare/realtimekit-react";

const RtkMeeting = lazy(() =>
  import("@cloudflare/realtimekit-react-ui").then((m) => ({
    default: m.RtkMeeting,
  }))
);

/* ---------- CHANGE THESE ---------- */
const COMPANY = "Down2Chill";
const BRAND = "#0D51FD";
/* --------------------------------- */

const box = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  gap: 12,
  padding: 20,
  boxSizing: "border-box",
};

const input = {
  padding: 12,
  width: 280,
  maxWidth: "100%",
  borderRadius: 8,
  border: "1px solid #333",
  background: "#141414",
  color: "#fff",
  fontSize: 15,
};

const button = {
  padding: "12px 24px",
  border: 0,
  borderRadius: 8,
  background: BRAND,
  color: "#fff",
  fontSize: 15,
  cursor: "pointer",
};

const brandStyle = { fontSize: 24, fontWeight: 600, marginBottom: 12 };
const errStyle = {
  color: "#ff6b6b",
  minHeight: 20,
  fontSize: 14,
  maxWidth: 460,
  textAlign: "center",
  wordBreak: "break-word",
};

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith("/j/")) return <Join />;
  return <NewMeeting />;
}

function Join() {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [joined, setJoined] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");

  const parts = window.location.pathname.split("/");
  const code = parts[parts.indexOf("j") + 1] || "";
  const hostKey =
    new URLSearchParams(window.location.search).get("host") || "";

  async function go() {
    setBusy(true);
    setErr("Connecting...");
    try {
      if (!code) {
        setErr("No meeting code in the URL.");
        setBusy(false);
        return;
      }

      // Start downloading the meeting UI bundle immediately, in parallel
      // with the token request, so neither waits on the other.
      const uiPreload = import("@cloudflare/realtimekit-react-ui");

      const r = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, hostKey, name, password: pw }),
      });
      const d = await r.json();
      if (!d.authToken) {
        setErr(d.error || "Could not join");
        console.log(d);
        setBusy(false);
        return;
      }

      await initMeeting({
        authToken: d.authToken,
        defaults: { audio: true, video: true },
      });

      await uiPreload;

      setErr("");
      setJoined(true);
    } catch (e) {
      setErr("Error: " + (e && e.message ? e.message : e));
      console.error(e);
      setBusy(false);
    }
  }

  if (joined && meeting) {
    return (
      <RealtimeKitProvider value={meeting}>
        <Suspense fallback={<div style={box}>Loading meeting...</div>}>
          <RtkMeeting
            meeting={meeting}
            showSetupScreen={true}
            style={{ height: "100vh", width: "100vw" }}
          />
        </Suspense>
      </RealtimeKitProvider>
    );
  }

  return (
    <div style={box}>
      <div style={brandStyle}>{COMPANY}</div>
      <input
        style={input}
        placeholder="Your name"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        style={input}
        type="password"
        placeholder="Password (if required)"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      <button style={button} onClick={go} disabled={busy}>
        Join meeting
      </button>
      <div style={errStyle}>{err}</div>
    </div>
  );
}

function NewMeeting() {
  const [title, setTitle] = useState("");
  const [pw, setPw] = useState("");
  const [links, setLinks] = useState(null);
  const [err, setErr] = useState("");

  async function create() {
    setErr("Creating...");
    try {
      const r = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, password: pw }),
      });
      const d = await r.json();
      if (d.error) {
        setErr(d.error);
        console.log(d);
        return;
      }
      setErr("");
      setLinks(d);
    } catch (e) {
      setErr("Error: " + (e && e.message ? e.message : e));
      console.error(e);
    }
  }

  return (
    <div style={box}>
      <div style={brandStyle}>{COMPANY}</div>
      <input
        style={input}
        placeholder="Meeting title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        style={input}
        placeholder="Password (optional)"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      <button style={button} onClick={create}>
        Create meeting
      </button>
      <div style={errStyle}>{err}</div>
      {links && (
        <div style={{ maxWidth: 460, fontSize: 14, wordBreak: "break-all" }}>
          <p>
            <b>Host link (you):</b>
            <br />
            <a style={{ color: BRAND }} href={links.hostLink}>
              {links.hostLink}
            </a>
          </p>
          <p>
            <b>Invite link (everyone else):</b>
            <br />
            <a style={{ color: BRAND }} href={links.guestLink}>
              {links.guestLink}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
