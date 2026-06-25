import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchTool } from "./tools/hashline-patch.js";
import { readTool } from "./tools/hashline-read.js";

export default function piHashlinePatch(pi: ExtensionAPI): void {
  pi.registerTool(readTool);
  pi.registerTool(patchTool);

  pi.on("session_start", () => {
    const activeTools = pi.getActiveTools();
    const requiredHashlineTools = ["read", "patch"];
    const withoutConflictingTools = activeTools.filter(
      (tool) => tool !== "edit" && tool !== "write" && tool !== "hashline_read" && tool !== "hashline_patch"
    );
    pi.setActiveTools([...new Set([...withoutConflictingTools, ...requiredHashlineTools])]);
  });
}
