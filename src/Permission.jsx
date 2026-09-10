/* What to show when the camera or microphone did not start.

   The distinction that decides everything here is dismissed vs blocked.

   A *dismissed* prompt (closed, swiped away, ignored) leaves the permission at
   "ask". Asking again really does bring the prompt straight back, no reload
   involved -- so that case is simply a button.

   A *blocked* one does not. permissions.revoke() was removed from the platform
   years ago, and clearing localStorage, cookies or the whole origin's storage
   does not touch permissions: browsers keep those in the profile, not in site
   storage. So wiping page data would change nothing, and neither does the
   reload the SDK suggests -- a browser told to block stops asking, full stop.
   Only the person can undo it, in their own browser's settings.

   Either way the retry runs against the live meeting. enableVideo/enableAudio
   acquire the device and publish it; they do not touch the connection, so the
   call carries on underneath this panel. */

import { useState } from "react";

const KIND = {
  video: { label: "Camera", lower: "camera" },
  audio: { label: "Microphone", lower: "microphone" },
};

// Rough, and deliberately so: this only picks which sentence to show, and the
// fallback sentence is true everywhere.
function whereToLook() {
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);

  if (/Firefox|FxiOS/i.test(ua))
    return android
      ? "Tap the padlock to the left of the address bar, open the site's permissions and clear the blocked entry, then set it to Allow."
      : "Click the padlock to the left of the address bar. Blocked permissions are listed there with an x beside them; clear it, then choose Allow.";

  if (/Edg\//i.test(ua))
    return "Click the padlock (or the camera icon) at the left of the address bar, open Permissions for this site and switch it to Allow.";

  if (/Chrome|CriOS/i.test(ua))
    return android
      ? "Tap the padlock to the left of the address bar, choose Permissions, and switch it to Allow."
      : "Click the camera icon at the right of the address bar, or the padlock at the left, and switch it to Allow.";

  if (/Safari/i.test(ua))
    return "Open Safari > Settings for This Website (or right-click the address bar) and set it to Allow.";

  return "Open your browser's site settings for this page and switch it to Allow.";
}

function systemHint() {
  const ua = navigator.userAgent;
  if (/Mac OS X/i.test(ua))
    return "Open System Settings > Privacy & Security and give your browser access, then come back and press Try again.";
  if (/Windows/i.test(ua))
    return "Open Settings > Privacy & security and give your browser access, then come back and press Try again.";
  return "Give your browser access in your device's privacy settings, then come back and press Try again.";
}

function copyFor(state, k) {
  switch (state) {
    case "dismissed":
      return {
        title: "The " + k.lower + " prompt was closed",
        body:
          "Nothing is blocked — your browser is still willing to ask. Press the button below and the prompt comes straight back.",
        action: "Ask again",
      };
    case "system":
      return {
        title: "Your device is blocking the " + k.lower,
        body: systemHint(),
        action: "Try again",
      };
    case "busy":
      return {
        title: "The " + k.lower + " is already in use",
        body:
          "Another app or browser tab has hold of it. Close whatever else is using it, then try again.",
        action: "Try again",
      };
    case "missing":
      return {
        title: "No " + k.lower + " found",
        body:
          "Nothing is connected that we can use. Plug something in, then try again.",
        action: "Try again",
      };
    default: // "browser"
      return {
        title: "This browser is blocking the " + k.lower,
        body:
          "Once a browser has been told to block, it stops asking, and reloading will not bring the prompt back. " +
          whereToLook(),
        action: "Try again",
      };
  }
}

export default function PermissionBlocked({ info, client, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const k = KIND[info.kind] || KIND.video;
  const { title, body, action } = copyFor(info.state, k);

  async function retry() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // Acquires the device and publishes it on the meeting that is already
      // running. Nothing here reconnects, so the call is not interrupted.
      if (info.kind === "audio") await client.self.enableAudio();
      else await client.self.enableVideo();
      onDismiss();
    } catch (e) {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="perm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={k.label + " unavailable"}
    >
      <div className="card narrow perm-card">
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          {k.label}
        </div>
        <div className="card-title" style={{ fontSize: 20, marginBottom: 10 }}>
          {title}
        </div>

        <p className="muted" style={{ marginBottom: 14 }}>
          {body}
        </p>

        <div className="stack">
          <button className="btn" onClick={retry} disabled={busy}>
            {busy ? "Asking..." : action}
          </button>
          <button className="btn btn-ghost" onClick={onDismiss} disabled={busy}>
            Not now
          </button>
        </div>

        <div className="err" style={{ marginTop: 14 }}>
          {failed
            ? info.state === "dismissed"
              ? "Still nothing. It may have been blocked rather than dismissed."
              : "Still no luck. The setting may not have saved yet."
            : ""}
        </div>

        <div className="hint" style={{ marginTop: 6 }}>
          You stay in the meeting either way. This only turns on your own{" "}
          {k.lower}, and never disconnects the call.
        </div>
      </div>
    </div>
  );
}
