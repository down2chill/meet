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
// Which way the video should be fitted depends on how the device is held.
//
// Upright, the camera shoots a tall frame into a tile that is nothing like as
// tall, and 'cover' throws most of it away — that one needs 'contain', bars and
// all. Turned sideways, camera and tile agree, and 'cover' fills the tile
// exactly: 'contain' there would add bars for no reason. So it follows the
// orientation instead of being fixed either way.
const currentFit = () =>
  window.matchMedia("(orientation: portrait)").matches ? "contain" : "cover";

const brandedConfig = () =>
  extendConfig({
    designTokens: MEETING_TOKENS,
    config: { videoFit: currentFit() },
  });
const baseConfig = brandedConfig();

export default function Meeting({ client, skipSetup }) {
  const addon = useRef(null);
  const [config, setConfig] = useVideoBackground(client, addon);
  const [blocked, dismissBlocked] = useBlockedMedia(client);
  const joined = useJoined(client);

  useVideoFit(setConfig);
  useCameraSwitchFix(client, addon);

  return (
    <div className={joined ? "meeting-root" : "meeting-root setup"}>
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
          // Skipped only on the reload we asked for to re-trigger a device
          // prompt: false here makes the SDK join as soon as it is ready, so
          // nobody has to press Join twice to get their camera back.
          showSetupScreen={!skipSetup}
          // mode="fill" makes the SDK style its host position:relative instead
          // of the default fixed, so it sizes to this container -- which is why
          // it needs an explicit height. Do not move this into a stylesheet: an
          // outer rule targeting the host also overrides the :host display:flex
          // the meeting UI is built on, and setting display there collapses the
          // entire layout, self-view included.
          mode="fill"
          style={{ height: "100%", width: "100%" }}
        />
      </RealtimeKitProvider>

      {blocked && (
        <PermissionBlocked
          info={blocked}
          client={client}
          onDismiss={dismissBlocked}
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

// The SDK reports device trouble through these two events. The distinction
// that matters most is CANCELED vs DENIED: a dismissed prompt leaves the
// permission at "ask", so requesting again really does bring the prompt back,
// while a blocked one does not and no amount of asking (or reloading) will.
//
// Only states a person can actually act on are listed. COULD_NOT_START in
// particular is deliberately absent: a device that is merely busy resolves
// itself, the SDK already says so in its own UI, and putting a panel over the
// meeting for it turns one unlucky moment into something that keeps coming
// back. Anything not named here is left to the SDK.
const MEDIA_STATE = {
  CANCELED: "dismissed",
  DENIED: "browser",
  SYSTEM_DENIED: "system",
};

function useBlockedMedia(client) {
  const [blocked, setBlockedState] = useState(null);
  // Once someone has waved this away for a device, it does not come back on its
  // own. These events can repeat on every failed attempt, and a panel that
  // reopens itself over a running meeting is worse than no panel at all.
  const waved = useRef({});

  useEffect(() => {
    const onPermission = ({ message, kind }) => {
      if (kind === "screenshare") return; // its own flow, never silently denied
      if (message === "ACCEPTED") {
        waved.current[kind] = false;
        setBlockedState((b) => (b && b.kind === kind ? null : b));
        return;
      }
      const state = MEDIA_STATE[message];
      if (!state || waved.current[kind]) return;
      setBlockedState((b) => (b ? b : { state, kind }));
    };

    client.self.addListener("mediaPermissionUpdate", onPermission);
    client.self.addListener("mediaPermissionError", onPermission);
    return () => {
      client.self.removeListener("mediaPermissionUpdate", onPermission);
      client.self.removeListener("mediaPermissionError", onPermission);
    };
  }, [client]);

  const dismiss = () => {
    setBlockedState((b) => {
      if (b) waved.current[b.kind] = true;
      return null;
    });
  };

  return [blocked, dismiss];
}

/**
 * Adds the blur / virtual background control to the control bar, for everyone
 * in the room — the addon is not preset-aware, so hosts and guests get the same
 * button. Returns the UI config to render with: the plain branded one until the
 * addon is ready, then the one with the control in it.
 */
function useVideoBackground(client, addonRef) {
  const [config, setConfig] = useState(baseConfig);
  // brandedConfig() reads the live orientation, so the addon's own setConfig
  // below cannot stomp on whatever useVideoFit has settled on.

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

  return [config, setConfig];
}

/**
 * Keeps config.videoFit in step with how the phone is being held. Patching the
 * one field rather than rebuilding keeps the addon's control-bar buttons in
 * place; the new top-level object is what makes the SDK notice at all.
 */
function useVideoFit(setConfig) {
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const apply = () => {
      const fit = currentFit();
      setConfig((prev) =>
        prev.config && prev.config.videoFit === fit
          ? prev
          : { ...prev, config: { ...prev.config, videoFit: fit } }
      );
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [setConfig]);
}

// Before the Join button is pressed we are on the SDK's setup screen, which
// needs different treatment on a short landscape viewport. See theme.css.
function useJoined(client) {
  const [joined, setJoined] = useState(() => !!client.self.roomJoined);

  useEffect(() => {
    const on = () => setJoined(true);
    const off = () => setJoined(false);
    client.self.addListener("roomJoined", on);
    client.self.addListener("roomLeft", off);
    return () => {
      client.self.removeListener("roomJoined", on);
      client.self.removeListener("roomLeft", off);
    };
  }, [client]);

  return joined;
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
