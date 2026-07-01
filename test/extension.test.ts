import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piSelectorPatch from "../src/index.js";
import { patchTool } from "../src/tools/selector-patch.js";

describe("extension registration", () => {
  it("keeps built-in read by default while hiding read_hash/write/edit", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousProfile = process.env.PI_SELECTOR_PATCH_PROFILE;
    process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-selector-patch-agent-"));
    delete process.env.PI_SELECTOR_PATCH_PROFILE;
    try {
      const registeredTools: string[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = [
        "read",
        "edit",
        "write",
        "selector_read",
        "selector_patch",
      ];

      piSelectorPatch({
        registerTool(tool: { name: string }) {
          registeredTools.push(tool.name);
        },
        on(
          event: string,
          handler: (event: unknown, ctx: unknown) => Promise<void> | void,
        ) {
          if (event === "session_start") {
            sessionStart = handler;
          }
        },
        getActiveTools() {
          return activeTools;
        },
        setActiveTools(nextTools: string[]) {
          activeTools = nextTools;
        },
      } as never);

      expect(registeredTools).toEqual(["patch"]);

      await sessionStart?.(
        {},
        { cwd: process.cwd(), isProjectTrusted: () => false },
      );

      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(patchTool.promptGuidelines).toHaveLength(1);
      expect(patchTool.promptGuidelines?.join("\n")).toContain(
        "classic profile active",
      );
      expect(patchParameterDescription()).toContain("Hunk Match: Classic Profile");
      expect(patchParameterNames()).not.toContain("markerless_selector");
      expect(activeTools).not.toContain("write");
      expect(activeTools).not.toContain("edit");
      expect(activeTools).not.toContain("selector_read");
      expect(activeTools).not.toContain("selector_patch");
    } finally {
      restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnv("PI_SELECTOR_PATCH_PROFILE", previousProfile);
    }
  });

  it("uses smart profile defaults without replacing read", async () => {
    const previousProfile = process.env.PI_SELECTOR_PATCH_PROFILE;
    process.env.PI_SELECTOR_PATCH_PROFILE = "smart";
    try {
      const registeredTools: string[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = ["read", "read_hash", "edit", "write"];

      piSelectorPatch({
        registerTool(tool: { name: string }) {
          registeredTools.push(tool.name);
        },
        on(
          event: string,
          handler: (event: unknown, ctx: unknown) => Promise<void> | void,
        ) {
          if (event === "session_start") sessionStart = handler;
        },
        getActiveTools() {
          return activeTools;
        },
        setActiveTools(nextTools: string[]) {
          activeTools = nextTools;
        },
      } as never);

      await sessionStart?.(
        {},
        { cwd: process.cwd(), isProjectTrusted: () => false },
      );

      expect(registeredTools).not.toContain("read");
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(patchTool.promptGuidelines).toHaveLength(1);
      expect(patchTool.promptGuidelines?.join("\n")).toContain(
        "smart profile active",
      );
      expect(patchParameterDescription()).toContain("Hunk Match: Smart Profile");
      expect(patchParameterDescription()).not.toMatch(/\bmarker(?:less)?\b/i);
      expect(patchParameterNames()).not.toContain("markerless_selector");
    } finally {
      restoreEnv("PI_SELECTOR_PATCH_PROFILE", previousProfile);
    }
  });

  it("registers the hash reader as read when hash profile is enabled", async () => {
    const previousProfile = process.env.PI_SELECTOR_PATCH_PROFILE;
    process.env.PI_SELECTOR_PATCH_PROFILE = "hash";
    try {
      const registeredTools: string[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = ["read", "read_hash", "edit", "write"];

      piSelectorPatch({
        registerTool(tool: { name: string }) {
          registeredTools.push(tool.name);
        },
        on(
          event: string,
          handler: (event: unknown, ctx: unknown) => Promise<void> | void,
        ) {
          if (event === "session_start") sessionStart = handler;
        },
        getActiveTools() {
          return activeTools;
        },
        setActiveTools(nextTools: string[]) {
          activeTools = nextTools;
        },
      } as never);

      await sessionStart?.(
        {},
        { cwd: process.cwd(), isProjectTrusted: () => false },
      );

      expect(registeredTools).toContain("read");
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(patchTool.promptGuidelines).toHaveLength(1);
      expect(patchTool.promptGuidelines?.join("\n")).toContain(
        "Hash profile active",
      );
      expect(patchParameterDescription()).toContain("Hunk Match: Hash Profile");
      expect(patchParameterDescription()).not.toMatch(/\bmarker(?:less)?\b/i);
      expect(patchParameterNames()).not.toContain("markerless_selector");
    } finally {
      restoreEnv("PI_SELECTOR_PATCH_PROFILE", previousProfile);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function patchParameterDescription(): string {
  const parameters = patchTool.parameters as {
    properties: { patch: { description?: string } };
  };
  return parameters.properties.patch.description ?? "";
}

function patchParameterNames(): string[] {
  const parameters = patchTool.parameters as { properties: Record<string, unknown> };
  return Object.keys(parameters.properties);
}
