import { describe, expect, it } from "vitest";
import piLocatorPatch from "../src/index.js";
import { patchTool } from "../src/tools/locator-patch.js";

describe("extension registration", () => {
  it("keeps built-in read by default while hiding read_hash/write/edit", async () => {
    const previous = process.env.PI_LOCATOR_PATCH_HASH_MODE;
    process.env.PI_LOCATOR_PATCH_HASH_MODE = "0";
    try {
      const registeredTools: string[] = [];
      let sessionStart: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = ["read", "edit", "write", "locator_read", "locator_patch"];

      piLocatorPatch({
        registerTool(tool: { name: string }) {
          registeredTools.push(tool.name);
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
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

      expect(registeredTools).toEqual(["patch"]);

      await sessionStart?.({}, { cwd: process.cwd(), isProjectTrusted: () => false });

      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(patchTool.promptGuidelines?.join("\n")).not.toContain("Hash mode");
      expect(activeTools).not.toContain("write");
      expect(activeTools).not.toContain("edit");
      expect(activeTools).not.toContain("locator_read");
      expect(activeTools).not.toContain("locator_patch");
    } finally {
      if (previous === undefined) delete process.env.PI_LOCATOR_PATCH_HASH_MODE;
      else process.env.PI_LOCATOR_PATCH_HASH_MODE = previous;
    }
  });

  it("registers the hash reader as read when hash mode is enabled", async () => {
    const previous = process.env.PI_LOCATOR_PATCH_HASH_MODE;
    process.env.PI_LOCATOR_PATCH_HASH_MODE = "1";
    try {
      const registeredTools: string[] = [];
      let sessionStart: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = ["read", "read_hash", "edit", "write"];

      piLocatorPatch({
        registerTool(tool: { name: string }) {
          registeredTools.push(tool.name);
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
          if (event === "session_start") sessionStart = handler;
        },
        getActiveTools() {
          return activeTools;
        },
        setActiveTools(nextTools: string[]) {
          activeTools = nextTools;
        }
      } as never);

      await sessionStart?.({}, { cwd: process.cwd(), isProjectTrusted: () => false });

      expect(registeredTools).toContain("read");
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(patchTool.promptGuidelines?.join("\n")).toContain("Hash mode active");
    } finally {
      if (previous === undefined) delete process.env.PI_LOCATOR_PATCH_HASH_MODE;
      else process.env.PI_LOCATOR_PATCH_HASH_MODE = previous;
    }
  });
});
