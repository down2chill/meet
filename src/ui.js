/* Shared brand, styling and the one fetch wrapper every page uses. */

/* ---------- CHANGE THESE ---------- */
export const COMPANY = "Down2Chill";
export const BRAND = "#0D51FD";
/* --------------------------------- */

// Same alphabet the Worker generates codes from: no i, l or o, so a code can
// be read down a phone line without ambiguity.
export const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_RE = new RegExp("^[" + ALPHA + "]{8}$");

// Accepts a bare code or a pasted invite link.
export function extractCode(raw) {
  const s = String(raw || "").trim();
  const inLink = s.match(/\/j\/([a-z0-9]{8})/i);
  return (inLink ? inLink[1] : s).toLowerCase().replace(/[\s-]/g, "");
}

export async function api(path, opts) {
  const { method = "GET", body } = opts || {};
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  // The Worker requires this on every write. A cross-site form post cannot
  // set it, which is what makes CSRF a non-issue here.
  if (method !== "GET") headers["X-CSRF"] = "1";

  const r = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });

  let data = null;
  try {
    data = await r.json();
  } catch (e) {
    /* non-JSON error page */
  }
  return { status: r.status, ok: r.ok, body: data || {} };
}

export const page = {
  minHeight: "100%",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "32px 20px 48px",
};

export const centred = {
  ...page,
  justifyContent: "center",
  height: "100%",
};

export const card = {
  width: "100%",
  background: "#111",
  border: "1px solid #262626",
  borderRadius: 14,
  padding: 24,
  boxSizing: "border-box",
};

// Single-purpose pages (join, sign in) read better in a narrow column. The
// dashboard lets its cards fill the wider container instead.
export const narrow = { width: "100%", maxWidth: 420 };

export const brandStyle = {
  fontSize: 24,
  fontWeight: 600,
  marginBottom: 20,
  letterSpacing: -0.3,
};

export const input = {
  padding: 12,
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 8,
  border: "1px solid #333",
  background: "#141414",
  color: "#fff",
  fontSize: 15,
  fontFamily: "inherit",
};

export const codeInput = {
  ...input,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 22,
  letterSpacing: 6,
  textAlign: "center",
  padding: "14px 12px",
};

export const button = {
  padding: "12px 20px",
  border: 0,
  borderRadius: 8,
  background: BRAND,
  color: "#fff",
  fontSize: 15,
  fontWeight: 500,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
};

export const ghost = {
  ...button,
  background: "transparent",
  border: "1px solid #333",
  color: "#ccc",
};

export const small = {
  ...button,
  width: "auto",
  padding: "7px 12px",
  fontSize: 13,
  background: "transparent",
  border: "1px solid #333",
  color: "#ccc",
};

export const danger = { ...small, borderColor: "#5a2020", color: "#ff8080" };

export const linkStyle = {
  background: "none",
  border: 0,
  color: "#8a8a8a",
  fontSize: 14,
  cursor: "pointer",
  padding: 8,
  fontFamily: "inherit",
  textDecoration: "underline",
};

export const errStyle = {
  color: "#ff6b6b",
  minHeight: 20,
  fontSize: 14,
  textAlign: "center",
  wordBreak: "break-word",
};

export const muted = { color: "#8a8a8a", fontSize: 13 };

export const label = {
  ...muted,
  display: "block",
  marginBottom: 6,
  textAlign: "left",
};

export const stack = { display: "flex", flexDirection: "column", gap: 12 };

export const row = { display: "flex", gap: 8, flexWrap: "wrap" };

export function when(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function expiresIn(unixSeconds) {
  if (!unixSeconds) return "";
  const days = Math.round((unixSeconds * 1000 - Date.now()) / 86400000);
  if (days <= 0) return "expires today";
  return "expires in " + days + (days === 1 ? " day" : " days");
}
