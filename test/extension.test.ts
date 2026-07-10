import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piSelectPatch from "../src/index.js";

describe("extension registration", () => {
  it("uses smart profile by default while hiding read_hash and edit and keeping write", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousProfile = process.env.PI_SELECT_PATCH_PROFILE;
    process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-select-patch-agent-"));
    delete process.env.PI_SELECT_PATCH_PROFILE;
    try {
      const registeredTools: RegisteredTool[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = [
        "read",
        "edit",
        "write",
        "selector_read",
        "selector_patch",
      ];

      piSelectPatch({
        registerTool(tool: RegisteredTool) {
          registeredTools.push(tool);
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

      expect(registeredToolNames(registeredTools)).toEqual([]);

      await sessionStart?.(
        {},
        { cwd: process.cwd(), isProjectTrusted: () => false },
      );

      expect(registeredToolNames(registeredTools)).toEqual(["patch"]);
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(registeredPatchTool(registeredTools).promptGuidelines).toHaveLength(1);
      expect(registeredPatchTool(registeredTools).promptGuidelines?.join("\n")).toContain(
        "smallest set of short selectors",
      );
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).toContain("Hunk Match: Smart Profile");
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).not.toContain("Add File");
      expect(patchParameterNames(registeredPatchTool(registeredTools))).not.toContain("markerless_selector");
      expect(activeTools).toContain("write");
      expect(activeTools).not.toContain("edit");
      expect(activeTools).not.toContain("selector_read");
      expect(activeTools).not.toContain("selector_patch");
    } finally {
      restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
    }
  });

  it("uses smart profile defaults without replacing read", async () => {
    const previousProfile = process.env.PI_SELECT_PATCH_PROFILE;
    process.env.PI_SELECT_PATCH_PROFILE = "smart";
    try {
      const registeredTools: RegisteredTool[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = ["read", "read_hash", "edit", "write"];

      piSelectPatch({
        registerTool(tool: RegisteredTool) {
          registeredTools.push(tool);
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

      expect(registeredToolNames(registeredTools)).toEqual(["patch"]);
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(activeTools).not.toContain("edit");
      expect(registeredPatchTool(registeredTools).promptGuidelines).toHaveLength(1);
      expect(registeredPatchTool(registeredTools).promptGuidelines?.join("\n")).toContain(
        "smallest set of short selectors",
      );
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).toContain("Hunk Match: Smart Profile");
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).toContain("/old");
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).toContain("=new");
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).not.toMatch(/\bmarker(?:less)?\b/i);
      expect(patchParameterNames(registeredPatchTool(registeredTools))).not.toContain("markerless_selector");
    } finally {
      restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
    }
  });

  it("registers the hash reader as read when hash profile is enabled", async () => {
    const previousProfile = process.env.PI_SELECT_PATCH_PROFILE;
    process.env.PI_SELECT_PATCH_PROFILE = "hash";
    try {
      const registeredTools: RegisteredTool[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
      let activeTools = ["read", "read_hash", "edit", "write"];

      piSelectPatch({
        registerTool(tool: RegisteredTool) {
          registeredTools.push(tool);
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

      expect(registeredToolNames(registeredTools)).toEqual(["patch", "read"]);
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("patch");
      expect(activeTools).not.toContain("edit");
      expect(registeredPatchTool(registeredTools).promptGuidelines).toHaveLength(1);
      expect(registeredPatchTool(registeredTools).promptGuidelines?.join("\n")).toContain(
        "Hash profile active",
      );
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).toContain("Hunk Match: Hash Profile");
      expect(patchParameterDescription(registeredPatchTool(registeredTools))).not.toMatch(/\bmarker(?:less)?\b/i);
      expect(patchParameterNames(registeredPatchTool(registeredTools))).not.toContain("markerless_selector");
    } finally {
      restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface RegisteredTool {
  name: string;
  promptGuidelines?: string[];
  parameters?: unknown;
}

function registeredToolNames(tools: RegisteredTool[]): string[] {
  return tools.map((tool) => tool.name);
}

function registeredPatchTool(tools: RegisteredTool[]): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === "patch");
  if (!tool) throw new Error("patch tool was not registered");
  return tool;
}

function patchParameterDescription(tool: RegisteredTool): string {
  const parameters = tool.parameters as {
    properties: { patch: { description?: string } };
  };
  return parameters.properties.patch.description ?? "";
}

function patchParameterNames(tool: RegisteredTool): string[] {
  const parameters = tool.parameters as { properties: Record<string, unknown> };
  return Object.keys(parameters.properties);
}
