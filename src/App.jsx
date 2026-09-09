import { useState, useEffect, lazy, Suspense } from "react";
import {
  COMPANY,
  CODE_RE,
  extractCode,
  api,
  centred,
  card,
  narrow,
  brandStyle,
  codeInput,
  input,
  button,
  ghost,
  linkStyle,
  errStyle,
  muted,
  label,
  stack,
} from "./ui.js";

// Neither of these is needed to render the landing page, and the meeting SDK
// is by far the biggest thing we ship. Keeping both out of the entry chunk
// means /  and /new load a fraction of what they used to.
const Join = lazy(() => import("./Join.jsx"));
const Admin = lazy(() => import("./Admin.jsx"));

const loading = <div style={centred}>Loading...</div>;

export default function App() {
  const path = location.pathname;

  if (path.startsWith("/j/"))
    return <Suspense fallback={loading}>{<Join />}</Suspense>;

  if (path === "/admin")
    return <Suspense fallback={loading}>{<Admin />}</Suspense>;

  return <Landing />;
}

function Landing() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [authed, setAuthed] = useState(null); // null = still checking
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    // Costs nothing when there is no session cookie: the Worker answers
    // without touching KV.
    api("/api/session").then(
      (r) => setAuthed(!!r.body.authed),
      () => setAuthed(false)
    );
  }, []);

  function go(e) {
    if (e) e.preventDefault();
    const c = extractCode(code);
    if (!c) return setErr("Enter your meeting code.");
    if (!CODE_RE.test(c))
      return setErr(
        c.length === 8
          ? "That code has characters we do not use. Check for i, l, o, 0 or 1."
          : "Meeting codes are 8 characters."
      );
    location.href = "/j/" + c;
  }

  return (
    <div style={centred}>
      <div style={{ ...card, ...narrow }}>
        <div style={brandStyle}>{COMPANY}</div>

        <form onSubmit={go} style={stack}>
          <label style={label} htmlFor="code">
            Meeting code
          </label>
          <input
            id="code"
            style={codeInput}
            placeholder="abcd2345"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            maxLength={64}
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (err) setErr("");
            }}
          />
          <button style={button} type="submit">
            Join meeting
          </button>
        </form>

        <div style={{ ...errStyle, marginTop: 12 }}>{err}</div>

        <div style={{ ...muted, marginTop: 8, textAlign: "center" }}>
          Paste the whole invite link if you have it.
        </div>
      </div>

      <div style={{ marginTop: 20, minHeight: 40 }}>
        {authed === true && (
          <a style={{ ...linkStyle, textDecoration: "none" }} href="/admin">
            Open dashboard
          </a>
        )}
        {authed === false && !showLogin && (
          <button style={linkStyle} onClick={() => setShowLogin(true)}>
            Log in
          </button>
        )}
      </div>

      {authed === false && showLogin && (
        <LoginCard onCancel={() => setShowLogin(false)} />
      )}
    </div>
  );
}

function LoginCard({ onCancel }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/login", {
        method: "POST",
        body: { username, password },
      });
      if (!r.ok) {
        setErr(r.body.error || "Could not sign in.");
        setBusy(false);
        return;
      }
      location.href = "/admin";
    } catch (e2) {
      setErr("Network error. Try again.");
      setBusy(false);
    }
  }

  return (
    <div style={{ ...card, ...narrow, marginTop: 4 }}>
      <form onSubmit={submit} style={stack}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Admin sign in</div>
        <input
          style={input}
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          style={input}
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button style={button} type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
        <button style={ghost} type="button" onClick={onCancel}>
          Cancel
        </button>
      </form>
      <div style={{ ...errStyle, marginTop: 12 }}>{err}</div>
    </div>
  );
}
