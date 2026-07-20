import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSelectorPatchConfig } from "./config.js";
import { createPatchTool } from "./tools/selector-patch.js";
import { createReplaceTool } from "./tools/replace.js";
import { hashProfileReadTool } from "./tools/selector-read.js";

export default function piSelectPatch(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const activeTools = pi.getActiveTools();
    const { profile, anchorMode } = await readSelectorPatchConfig();
    const editTool = createPatchTool(profile, anchorMode);
    const replaceTool = createReplaceTool();
    pi.registerTool(editTool);
    pi.registerTool(replaceTool);
    if (profile === "hash") {
      pi.registerTool(hashProfileReadTool);
    }
    const requiredSelectorTools = profile === "hash"
      ? [hashProfileReadTool.name, editTool.name, replaceTool.name]
      : [editTool.name, replaceTool.name];
    const withoutStaleSelectorTools = activeTools.filter(
      (tool) =>
        tool !== "read_hash" &&
        tool !== "selector_read" &&
        tool !== "selector_patch",
    );
    pi.setActiveTools([
      ...new Set([...withoutStaleSelectorTools, ...requiredSelectorTools]),
    ]);
  });
}
