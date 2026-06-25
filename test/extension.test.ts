import { describe, expect, it } from "vitest";
import piHashlinePatch from "../src/index.js";

describe("extension registration", () => {
  it("registers read/patch only and activates them while hiding write/edit", () => {
    const registeredTools: string[] = [];
    let sessionStart: (() => void) | undefined;
    let activeTools = ["read", "edit", "write", "hashline_read", "hashline_patch"];

    piHashlinePatch({
      registerTool(tool: { name: string }) {
        registeredTools.push(tool.name);
      },
      on(event: string, handler: () => void) {
        if (event === "session_start") {
          sessionStart = handler;
        }
      },
      getActiveTools() {
        return activeTools;
      },
      setActiveTools(nextTools: string[]) {
        activeTools = nextTools;
      }
    } as never);

    expect(registeredTools).toEqual(["read", "patch"]);

    sessionStart?.();

    expect(activeTools).toContain("read");
    expect(activeTools).toContain("patch");
    expect(activeTools).not.toContain("write");
    expect(activeTools).not.toContain("edit");
    expect(activeTools).not.toContain("hashline_read");
    expect(activeTools).not.toContain("hashline_patch");
  });
});
