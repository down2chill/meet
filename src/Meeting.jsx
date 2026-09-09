/* The meeting itself. Split into its own module so the SDK's UI kit — the
   largest chunk we ship — stays out of every other screen's download, and so
   the brand tokens are built in the same chunk that consumes them. */

import { RealtimeKitProvider } from "@cloudflare/realtimekit-react";
import { RtkMeeting, extendConfig } from "@cloudflare/realtimekit-react-ui";
import { MEETING_TOKENS } from "./ui.js";

// extendConfig merges onto the SDK's default UI config, so we only state the
// handful of things that differ: our palette, our font, our logo.
const config = extendConfig({ designTokens: MEETING_TOKENS });

export default function Meeting({ client }) {
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
