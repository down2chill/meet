/* Shared brand, the meeting theme and the one fetch wrapper every page uses.
   Everything visual lives in theme.css; this file only names the pieces. */

/* ---------- CHANGE THESE ---------- */
export const COMPANY = "Down2Chill";
export const SITE = "https://down2chill.com";
/* --------------------------------- */

// The palette the whole app is drawn from: the marketing site's pale-cyan
// accent over its deep-navy gradient.
export const ACCENT = "#dffcff";

// Design tokens for the RealtimeKit meeting UI, so the call itself looks like
// the rest of the site rather than the SDK default grey. The SDK writes these
// out as --rtk-* custom properties on <html> when the meeting mounts.
//
// theme:"dark" is applied first and then overridden by colors, so anything we
// leave out still lands on a sensible dark value.
export const MEETING_TOKENS = {
  theme: "dark",
  fontFamily: "Montserrat, ui-sans-serif, system-ui, sans-serif",
  borderRadius: "extra-rounded",
  borderWidth: "thin",
  spacingBase: 4,
  logo: "/brand/down2chill_light.svg",
  colors: {
    // Deepest first: 1000 is the app background, 600 the raised surfaces.
    background: {
      1000: "#050f24",
      900: "#0a1a38",
      800: "#0f2447",
      700: "#183157",
      600: "#22406b",
    },
    "video-bg": "#081428",
    text: "#ffffff",
    "text-on-brand": "#ffffff",
    brand: {
      300: "#b3a7ff",
      400: "#8f80f7",
      500: "#6c5ce7",
      600: "#5646c9",
      700: "#3f33a3",
    },
    danger: "#ff5c86",
    success: "#3fd8b1",
    warning: "#ffd66e",
  },
};

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
