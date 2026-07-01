import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSelectorPatchConfig } from "./config.js";
import {
  patchTool,
  setPatchToolProfileGuideline,
} from "./tools/selector-patch.js";
import { hashProfileReadTool } from "./tools/selector-read.js";

export default function piSelectorPatch(pi: ExtensionAPI): void {
  pi.registerTool(patchTool);

  pi.on("session_start", async (_event, ctx) => {
    const activeTools = pi.getActiveTools();
    const { profile } = await readSelectorPatchConfig();
    if (profile === "hash") {
      pi.registerTool(hashProfileReadTool);
    }
    const requiredSelectorTools =
      profile === "hash" ? [hashProfileReadTool.name, "patch"] : ["patch"];
    setPatchToolProfileGuideline(profile);
    const withoutConflictingTools = activeTools.filter(
      (tool) =>
        tool !== "read_hash" &&
        tool !== "edit" &&
        tool !== "write" &&
        tool !== "selector_read" &&
        tool !== "selector_patch",
    );
    pi.setActiveTools([
      ...new Set([...withoutConflictingTools, ...requiredSelectorTools]),
    ]);
  });
}
