import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPatchTool } from "../src/tools/selector-patch.js";

describe("selector edit rendering shell", () => {
  it("keeps Pi's boxed background when overriding the built-in edit tool", () => {
    initTheme("dark", false);
    const editTool = createPatchTool("smart");
    const component = new ToolExecutionComponent(
      "edit",
      "tool-call",
      { patch: ["*** Update File: file.txt", "@@", "-old", "+new"].join("\n") },
      undefined,
      editTool as never,
      { requestRender() {} } as never,
      process.cwd(),
    );

    expect(component.render(120).join("\n")).toContain("\u001b[48;");
  });
});
