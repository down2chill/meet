import { useState, useEffect, useCallback } from "react";
import {
  COMPANY,
  api,
  page,
  centred,
  card,
  narrow,
  brandStyle,
  input,
  button,
  ghost,
  small,
  danger,
  linkStyle,
  errStyle,
  muted,
  label,
  stack,
  row,
  when,
  expiresIn,
} from "./ui.js";

export default function Admin() {
  const [authed, setAuthed] = useState(null);
  const [username, setUsername] = useState("");
  const [meetings, setMeetings] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const r = await api("/api/meetings");
    if (r.status === 401) {
      setAuthed(false);
      return;
    }
    if (!r.ok) {
      setErr(r.body.error || "Could not load meetings.");
      return;
    }
    setMeetings(r.body.meetings || []);
    setTruncated(!!r.body.truncated);
  }, []);

  useEffect(() => {
    (async () => {
      const s = await api("/api/session");
      if (!s.body.authed) {
        setAuthed(false);
        return;
      }
      setAuthed(true);
      setUsername(s.body.username || "");
      load();
    })();
  }, [load]);

  if (authed === null) return <div style={centred}>Loading...</div>;

  if (authed === false)
    return (
      <div style={centred}>
        <div style={{ ...card, ...narrow, textAlign: "center" }}>
          <div style={brandStyle}>{COMPANY}</div>
          <p style={muted}>Your session has ended.</p>
          <a style={{ ...button, display: "block", textDecoration: "none" }} href="/">
            Go to sign in
          </a>
        </div>
      </div>
    );

  return (
    <div style={page}>
      <div style={{ width: "100%", maxWidth: 720 }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 24,
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ ...brandStyle, marginBottom: 0 }}>{COMPANY} admin</div>
          <div style={row}>
            <span style={muted}>{username}</span>
            <button
              style={linkStyle}
              onClick={async () => {
                await api("/api/logout", { method: "POST" });
                location.href = "/";
              }}
            >
              Sign out
            </button>
          </div>
        </header>

        <Create onCreated={load} />

        <div style={{ ...errStyle, margin: "16px 0" }}>{err}</div>

        <h2 style={{ fontSize: 15, fontWeight: 600, margin: "8px 0 12px" }}>
          Meetings{meetings ? " (" + meetings.length + ")" : ""}
        </h2>

        {meetings === null && <div style={muted}>Loading...</div>}
        {meetings && meetings.length === 0 && (
          <div style={{ ...card, ...muted }}>
            No meetings yet. Create one above.
          </div>
        )}

        <div style={stack}>
          {meetings &&
            meetings.map((m) => (
              <Meeting key={m.code} m={m} onChange={load} />
            ))}
        </div>

        {truncated && (
          <div style={{ ...muted, marginTop: 16 }}>
            Showing the first 1000 meetings.
          </div>
        )}
      </div>
    </div>
  );
}

function Create({ onCreated }) {
  const [title, setTitle] = useState("");
  const [pw, setPw] = useState("");
  const [links, setLinks] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/rooms", {
        method: "POST",
        body: { title, password: pw },
      });
      if (!r.ok) {
        setErr(r.body.error || "Could not create the meeting.");
        return;
      }
      setLinks(r.body);
      setTitle("");
      setPw("");
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={card}>
      <form onSubmit={submit} style={stack}>
        <label style={label}>New meeting</label>
        <input
          style={input}
          placeholder="Meeting title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          style={input}
          type="password"
          placeholder="Password (optional)"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button style={button} type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create meeting"}
        </button>
      </form>

      <div style={{ ...errStyle, marginTop: 12 }}>{err}</div>

      {links && (
        <div style={{ marginTop: 16 }}>
          <Copyable caption="Invite link" value={links.guestLink} />
          <Copyable caption="Host link (keep this one)" value={links.hostLink} />
        </div>
      )}
    </div>
  );
}

function Meeting({ m, onChange }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [hostLink, setHostLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const act = async (path, opts) => {
    setBusy(true);
    setErr("");
    const r = await api(path, opts);
    setBusy(false);
    if (!r.ok) {
      setErr(r.body.error || "That did not work.");
      return null;
    }
    return r.body;
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{m.title}</div>
          <div style={{ ...muted, marginTop: 4 }}>
            <code>{m.code}</code>
            {" · "}
            {when(m.createdAt)}
            {m.expiresAt ? " · " + expiresIn(m.expiresAt) : ""}
            {m.hasPassword ? " · password" : ""}
          </div>
        </div>
      </div>

      <div style={{ ...row, marginTop: 14 }}>
        <a
          style={{ ...small, textDecoration: "none", display: "inline-block" }}
          href={"/j/" + m.code}
        >
          Join as host
        </a>
        <CopyButton value={m.guestLink} labelText="Copy invite" />
        <button style={small} onClick={() => setEditing(!editing)} disabled={busy}>
          {editing ? "Close" : "Edit"}
        </button>
        <button
          style={small}
          disabled={busy}
          onClick={async () => {
            const b = await act("/api/meetings/" + m.code + "/host", {
              method: "POST",
            });
            if (b) setHostLink(b.hostLink);
          }}
        >
          New host link
        </button>
        {confirming ? (
          <>
            <button
              style={danger}
              disabled={busy}
              onClick={async () => {
                const b = await act("/api/meetings/" + m.code, { method: "DELETE" });
                if (b) onChange();
              }}
            >
              Really delete
            </button>
            <button style={small} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button style={danger} onClick={() => setConfirming(true)} disabled={busy}>
            Delete
          </button>
        )}
      </div>

      <div style={{ ...errStyle, textAlign: "left", marginTop: 8 }}>{err}</div>

      {hostLink && (
        <div style={{ marginTop: 12 }}>
          <Copyable
            caption="New host link (the previous one no longer works)"
            value={hostLink}
          />
        </div>
      )}

      {editing && (
        <Edit
          m={m}
          onSaved={() => {
            setEditing(false);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function Edit({ m, onSaved }) {
  const [title, setTitle] = useState(m.title);
  const [pw, setPw] = useState("");
  const [changePw, setChangePw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    // Only send password when the admin actually chose to change it, so an
    // untouched form never clears an existing one.
    const body = { title };
    if (changePw) body.password = pw;
    const r = await api("/api/meetings/" + m.code, { method: "POST", body });
    setBusy(false);
    if (!r.ok) {
      setErr(r.body.error || "Could not save.");
      return;
    }
    onSaved();
  }

  return (
    <form
      onSubmit={save}
      style={{
        ...stack,
        marginTop: 16,
        paddingTop: 16,
        borderTop: "1px solid #262626",
      }}
    >
      <label style={label}>Title</label>
      <input
        style={input}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      {!changePw ? (
        <button style={ghost} type="button" onClick={() => setChangePw(true)}>
          {m.hasPassword ? "Change or remove password" : "Add a password"}
        </button>
      ) : (
        <>
          <label style={label}>
            New password (leave empty to remove it)
          </label>
          <input
            style={input}
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </>
      )}

      <button style={button} type="submit" disabled={busy}>
        {busy ? "Saving..." : "Save"}
      </button>
      <div style={errStyle}>{err}</div>
    </form>
  );
}

function CopyButton({ value, labelText }) {
  const [done, setDone] = useState(false);
  return (
    <button
      style={small}
      onClick={async () => {
        const ok = await copy(value);
        setDone(ok);
        if (ok) setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : labelText}
    </button>
  );
}

function Copyable({ caption, value }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={label}>{caption}</div>
      <div style={row}>
        <input style={{ ...input, flex: 1, minWidth: 200 }} readOnly value={value} />
        <CopyButton value={value} labelText="Copy" />
      </div>
    </div>
  );
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false; // insecure context or permission refused
  }
}
