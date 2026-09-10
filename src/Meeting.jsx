/* The meeting itself. Split into its own module so the SDK's UI kit — the
   largest chunk we ship — stays out of every other screen's download, and so
   the brand tokens are built in the same chunk that consumes them. */

import { useEffect, useRef, useState } from "react";
import { RealtimeKitProvider } from "@cloudflare/realtimekit-react";
import {
  RtkMeeting,
  extendConfig,
  registerAddons,
} from "@cloudflare/realtimekit-react-ui";
import {
  MEETING_TOKENS,
  BACKGROUNDS,
  saveBackground,
  loadBackground,
  backgroundEffectsSupported,
} from "./ui.js";
import PermissionBlocked from "./Permission.jsx";

// extendConfig merges onto the SDK's default UI config, so we only state the
// handful of things that differ: our palette, our font, our logo. Each call
// deep-clones that default, so every config handed out here is independent.
const brandedConfig = () =>
  extendConfig({
    designTokens: MEETING_TOKENS,
    config: {
      // The SDK defaults to 'cover', which crops every tile to fill it — a
      // phone held upright loses most of the frame. 'contain' letterboxes
      // instead: bars down the sides, but the whole picture is there.
      videoFit: "contain",
    },
  });
const baseConfig = brandedConfig();

export default function Meeting({ client }) {
  const addon = useRef(null);
  const config = useVideoBackground(client, addon);
  const [blocked, setBlocked] = useBlockedMedia(client);

  useCameraSwitchFix(client, addon);

  return (
    <div className="meeting-root">
      <RealtimeKitProvider value={client}>
        <RtkMeeting
          meeting={client}
          config={config}
          // Without this the SDK ignores config.designTokens entirely and the
          // call renders in its default grey: rtk-meeting only writes the
          // --rtk-* custom properties when applyDesignSystem is set.
          applyDesignSystem
          // The setup screen is the entry room: name, camera preview and
          // device pickers, and the natural place for a permission prompt.
          showSetupScreen
          mode="fill"
          style={{ height: "100%", width: "100%" }}
        />
      </RealtimeKitProvider>

      {blocked && (
        <PermissionBlocked
          info={blocked}
          client={client}
          onDismiss={() => setBlocked(null)}
        />
      )}
    </div>
  );
}

/**
 * Switching camera leaves the preview black until something else forces a
 * re-render — toggling Mirror is the usual accidental cure.
 *
 * The SDK's tiles (rtk-participant-setup, and the in-call tile) cache the last
 * `videoUpdate` payload and only re-attach the <video> element's srcObject when
 * a new one arrives. Changing device tears the old track down and builds a new
 * one, and the events fired around that swap can leave the cached payload
 * describing the torn-down state — a stopped track, or videoEnabled:false,
 * which also drops the tile's `visible` class. Nothing corrects it afterwards,
 * so it stays black until a re-render re-reads the live values.
 *
 * So we re-emit `videoUpdate` ourselves, built from the SDK's own live getters.
 * It stops and starts nothing and republishes nothing — it says only what is
 * already true, just says it again once the swap has settled. Fired twice
 * because the SDK's own track-change handler is async and can land after the
 * first one.
 *
 * Note the emit rather than self.setVideoEnabled(true), which looks like the
 * tidier call and is in the public types: Self overrides `videoEnabled` with a
 * getter and no setter, so the setter it inherits from Participant would throw
 * on assignment. The SDK only ever calls it on remote participants.
 */
function useCameraSwitchFix(client, addonRef) {
  useEffect(() => {
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));

    const resync = () => {
      const self = client.self;
      if (!self.videoEnabled || !self.videoTrack) return;
      self.emit("videoUpdate", {
        videoEnabled: self.videoEnabled,
        videoTrack: self.videoTrack,
      });
    };

    // A background effect builds its pipeline around the track it was handed.
    // The new camera is a different track, so the effect has to be re-applied
    // or it renders from a source that no longer produces frames.
    const reapplyBackground = () => {
      const a = addonRef.current;
      if (!a) return;
      const mode = a.currentBackgroundMode;
      if (!mode || mode === "none") return;
      const p =
        mode === "blur"
          ? a.applyBlurBackground()
          : a.applyVirtualBackground(a.currentBackgroundURL);
      Promise.resolve(p).catch(() => {});
    };

    const onDevice = ({ device }) => {
      if (!device || device.kind !== "videoinput") return;
      at(0, resync);
      at(500, resync);
      at(600, reapplyBackground);
    };

    client.self.addListener("deviceUpdate", onDevice);
    return () => {
      client.self.removeListener("deviceUpdate", onDevice);
      timers.forEach(clearTimeout);
    };
  }, [client, addonRef]);
}

// The SDK reports a blocked device through these two events. DENIED is the
// browser refusing, SYSTEM_DENIED is the operating system refusing on the
// browser's behalf, and they need different advice.
const BLOCKED_SCOPE = { DENIED: "browser", SYSTEM_DENIED: "system" };

function useBlockedMedia(client) {
  const [blocked, setBlocked] = useState(null);

  useEffect(() => {
    const onPermission = ({ message, kind }) => {
      if (kind === "screenshare") return; // its own flow, never silently denied
      const scope = BLOCKED_SCOPE[message];
      if (scope) setBlocked({ scope, kind });
      else if (message === "ACCEPTED") setBlocked(null);
    };

    client.self.addListener("mediaPermissionUpdate", onPermission);
    client.self.addListener("mediaPermissionError", onPermission);
    return () => {
      client.self.removeListener("mediaPermissionUpdate", onPermission);
      client.self.removeListener("mediaPermissionError", onPermission);
    };
  }, [client]);

  return [blocked, setBlocked];
}

/**
 * Adds the blur / virtual background control to the control bar, for everyone
 * in the room — the addon is not preset-aware, so hosts and guests get the same
 * button. Returns the UI config to render with: the plain branded one until the
 * addon is ready, then the one with the control in it.
 */
function useVideoBackground(client, addonRef) {
  const [config, setConfig] = useState(baseConfig);

  useEffect(() => {
    // Segmentation needs WebGL, and the SDK does not support it on iOS at all.
    // Better to show no button than one that cannot work.
    if (!backgroundEffectsSupported()) return;

    let addon = null;
    let stopRestore = null;
    let cancelled = false;

    (async () => {
      // Another ~110 kB of segmentation glue, fetched after the meeting is
      // already on screen so it never sits on the join path.
      const { default: VideoBGAddon } = await import(
        "@cloudflare/realtimekit-ui-addons/video-background"
      );

      addon = await VideoBGAddon.init({
        meeting: client,
        modes: ["blur", "virtual"],
        images: BACKGROUNDS,
        blurStrength: 30,
        buttonLabel: "Background",
        // Fires on every change, including "none", which is how the choice
        // gets remembered for next time.
        onVideoBackgroundUpdate: saveBackground,
      });

      if (cancelled) {
        addon.unregister();
        return;
      }

      addonRef.current = addon;

      // Two things about this line.
      //
      // The third argument is required: without it registerAddons builds on
      // the SDK's default config and every design token above is thrown away.
      //
      // It has to be a *fresh* config rather than baseConfig, because
      // RtkUiBuilder.build() returns the very object it was handed. The addon
      // edits the config in place, so passing baseConfig would both scribble
      // on our module-level copy and hand setConfig the reference it is
      // already holding -- which React skips, leaving the button invisible.
      // extendConfig deep-clones the SDK default every call, so this is a
      // tree of its own.
      setConfig(registerAddons([addon], client, brandedConfig()));
      stopRestore = restoreSaved(client, addon);
    })().catch((e) => {
      // A failed addon must never take the meeting down with it: the call
      // simply runs without the background control.
      console.error("Background effects unavailable:", e);
    });

    return () => {
      cancelled = true;
      addonRef.current = null;
      if (stopRestore) stopRestore();
      if (addon) addon.unregister();
    };
  }, [client, addonRef]);

  return config;
}

/**
 * Re-applies the background this device last chose. The middleware attaches to
 * a live camera track, so when the camera is still off — the setup screen, or a
 * join that started without devices — it waits for the camera to come on.
 * Returns a cleanup function, or null when there was nothing to wait for.
 */
function restoreSaved(client, addon) {
  const saved = loadBackground();
  if (!saved) return null;

  const apply = () => {
    const p =
      saved.mode === "blur"
        ? addon.applyBlurBackground()
        : addon.applyVirtualBackground(saved.url);
    // Applying reports failure in its result rather than throwing, but a
    // rejected promise here still must not reach the console as unhandled.
    Promise.resolve(p).catch(() => {});
  };

  if (client.self.videoEnabled) {
    apply();
    return null;
  }

  const onVideo = ({ videoEnabled }) => {
    if (!videoEnabled) return;
    client.self.removeListener("videoUpdate", onVideo);
    apply();
  };
  client.self.addListener("videoUpdate", onVideo);
  return () => client.self.removeListener("videoUpdate", onVideo);
}
