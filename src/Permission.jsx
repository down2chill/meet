/* What to show when the browser is blocking the camera or microphone.

   Worth being clear about the constraint: a page cannot un-deny its own
   permission. navigator.permissions.revoke() was removed from the platform
   years ago, and clearing localStorage, cookies or the whole origin's storage
   does not touch permissions: browsers keep those in the profile, not in
   site storage. So "wipe the page data" would change nothing, and neither does
   the reload the SDK suggests: a reload re-asks only if the browser was never
   told "block", and once it has been, it stays blocked until the person
   changes it.

   What we can do is stop showing them a dead end: say plainly what happened,
   point at the control that actually fixes it, and retry in place so they
   never have to reload and lose the room. */

import { useState } from "react";

const KIND_LABEL = { video: "Camera", audio: "Microphone" };

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
    return "Open System Settings > Privacy & Security and give your browser access, then come back.";
  if (/Windows/i.test(ua))
    return "Open Settings > Privacy & security > Camera and microphone and give your browser access, then come back.";
  return "Give your browser access in your device's privacy settings, then come back.";
}

export default function PermissionBlocked({ info, client, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const label = KIND_LABEL[info.kind] || "Camera";
  const system = info.scope === "system";

  async function retry() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // No reload needed: the moment the setting is changed, this call gets
      // the device. If it is still blocked it rejects immediately, which is
      // how we know to keep the panel up.
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
    <div className="perm-overlay" role="dialog" aria-modal="true" aria-label={label + " blocked"}>
      <div className="card narrow perm-card">
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          {label} blocked
        </div>
        <div className="card-title" style={{ fontSize: 20, marginBottom: 10 }}>
          {system
            ? "Your device is blocking the " + label.toLowerCase()
            : "This browser is blocking the " + label.toLowerCase()}
        </div>

        <p className="muted" style={{ marginBottom: 14 }}>
          {system
            ? systemHint()
            : "Once a browser has been told to block, it stops asking, and reloading will not bring the prompt back. " +
              whereToLook()}
        </p>

        <div className="stack">
          <button className="btn" onClick={retry} disabled={busy}>
            {busy ? "Checking..." : "Try again"}
          </button>
          <button className="btn btn-ghost" onClick={onDismiss} disabled={busy}>
            Continue without it
          </button>
        </div>

        <div className="err" style={{ marginTop: 14 }}>
          {failed ? "Still blocked. The setting may not have saved yet." : ""}
        </div>

        <div className="hint" style={{ marginTop: 6 }}>
          Allow it, then press Try again — no reload needed. You can also stay in the meeting without your{" "}
          {label.toLowerCase()}.
        </div>
      </div>
    </div>
  );
}
