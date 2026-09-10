/* The meeting itself. Split into its own module so the SDK's UI kit — the
   largest chunk we ship — stays out of every other screen's download, and so
   the brand tokens are built in the same chunk that consumes them. */

import { useEffect, useState } from "react";
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

// extendConfig merges onto the SDK's default UI config, so we only state the
// handful of things that differ: our palette, our font, our logo. Each call
// deep-clones that default, so every config handed out here is independent.
const brandedConfig = () => extendConfig({ designTokens: MEETING_TOKENS });
const baseConfig = brandedConfig();

export default function Meeting({ client }) {
  const config = useVideoBackground(client);

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
    </div>
  );
}

/**
 * Adds the blur / virtual background control to the control bar, for everyone
 * in the room — the addon is not preset-aware, so hosts and guests get the same
 * button. Returns the UI config to render with: the plain branded one until the
 * addon is ready, then the one with the control in it.
 */
function useVideoBackground(client) {
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
      if (stopRestore) stopRestore();
      if (addon) addon.unregister();
    };
  }, [client]);

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
