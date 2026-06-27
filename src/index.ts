import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readLocatorPatchConfig } from "./config.js";
import { patchTool, setPatchToolHashModeGuideline } from "./tools/locator-patch.js";
import { readHashTool } from "./tools/locator-read.js";

export default function piLocatorPatch(pi: ExtensionAPI): void {
  pi.registerTool(readHashTool);
  pi.registerTool(patchTool);

  pi.on("session_start", async (_event, ctx) => {
    const activeTools = pi.getActiveTools();
    const requiredLocatorTools = ["read_hash", "patch"];
    const { hashMode } = await readLocatorPatchConfig();
    setPatchToolHashModeGuideline(hashMode);
    const withoutConflictingTools = activeTools.filter(
      (tool) => (!hashMode || tool !== "read") && tool !== "edit" && tool !== "write" && tool !== "locator_read" && tool !== "locator_patch"
    );
    pi.setActiveTools([...new Set([...withoutConflictingTools, ...requiredLocatorTools])]);
  });
}
