import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSelectorPatchConfig } from "./config.js";
import { createPatchTool } from "./tools/selector-patch.js";
import { hashProfileReadTool } from "./tools/selector-read.js";

export default function piSelectPatch(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const activeTools = pi.getActiveTools();
    const { profile } = await readSelectorPatchConfig();
    const patchTool = createPatchTool(profile);
    pi.registerTool(patchTool);
    if (profile === "hash") {
      pi.registerTool(hashProfileReadTool);
    }
    const requiredSelectorTools =
      profile === "hash" ? [hashProfileReadTool.name, patchTool.name] : [patchTool.name];
    const withoutConflictingTools = activeTools.filter(
      (tool) =>
        tool !== "read_hash" &&
        tool !== "write" &&
        tool !== "selector_read" &&
        tool !== "selector_patch",
    );
    pi.setActiveTools([
      ...new Set([...withoutConflictingTools, ...requiredSelectorTools]),
    ]);
  });
}
