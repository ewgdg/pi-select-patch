import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piSelectPatch from "../src/index.js";

describe("extension registration", () => {
  it("registers selector edit over the built-in edit and keeps only edit active", async () => {
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

      expect(registeredToolNames(registeredTools)).toEqual(["edit"]);
      expect(registeredToolNames(registeredTools)).not.toContain("patch");
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("edit");
      expect(activeTools).not.toContain("patch");
      expect(registeredEditTool(registeredTools).promptGuidelines).toHaveLength(1);
      expect(registeredEditTool(registeredTools).promptGuidelines?.join("\n")).toContain(
        "smallest set of short selectors",
      );
      expect(patchParameterDescription(registeredEditTool(registeredTools))).toContain("Hunk Match: Smart Profile");
      expect(patchParameterNames(registeredEditTool(registeredTools))).toContain("patch");
      expect(activeTools).toContain("write");
      expect(activeTools).not.toContain("selector_read");
      expect(activeTools).not.toContain("selector_patch");
    } finally {
      restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
    }
  });

  it("binds configured tolerant anchor mode into the session edit tool", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousAnchorMode = process.env.PI_SELECT_PATCH_ANCHOR_MODE;
    const agentDir = await mkdtemp(join(tmpdir(), "pi-select-patch-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SELECT_PATCH_ANCHOR_MODE;
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ "pi-select-patch": { anchorMode: "tolerant" } }),
    );
    try {
      const registeredTools: RegisteredTool[] = [];
      let sessionStart:
        ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;

      piSelectPatch({
        registerTool(tool: RegisteredTool) {
          registeredTools.push(tool);
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
          if (event === "session_start") sessionStart = handler;
        },
        getActiveTools() {
          return ["read", "edit", "write"];
        },
        setActiveTools() {},
      } as never);

      await sessionStart?.({}, { cwd: process.cwd(), isProjectTrusted: () => false });

      expect(patchParameterDescription(registeredEditTool(registeredTools))).toContain(
        "tolerant hierarchical resolution",
      );
    } finally {
      restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnv("PI_SELECT_PATCH_ANCHOR_MODE", previousAnchorMode);
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

      expect(registeredToolNames(registeredTools)).toEqual(["edit"]);
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("edit");
      expect(activeTools).not.toContain("patch");
      expect(registeredEditTool(registeredTools).promptGuidelines).toHaveLength(1);
      expect(registeredEditTool(registeredTools).promptGuidelines?.join("\n")).toContain(
        "smallest set of short selectors",
      );
      expect(patchParameterDescription(registeredEditTool(registeredTools))).toContain("Hunk Match: Smart Profile");
      expect(patchParameterDescription(registeredEditTool(registeredTools))).toContain("/old");
      expect(patchParameterDescription(registeredEditTool(registeredTools))).toContain("=new");
      expect(patchParameterDescription(registeredEditTool(registeredTools))).not.toMatch(/\bmarker(?:less)?\b/i);
      expect(patchParameterNames(registeredEditTool(registeredTools))).not.toContain("markerless_selector");
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

      expect(registeredToolNames(registeredTools)).toEqual(["edit", "read"]);
      expect(activeTools).toContain("read");
      expect(activeTools).not.toContain("read_hash");
      expect(activeTools).toContain("edit");
      expect(activeTools).not.toContain("patch");
      expect(registeredEditTool(registeredTools).promptGuidelines).toHaveLength(1);
      expect(registeredEditTool(registeredTools).promptGuidelines?.join("\n")).toContain(
        "Hash profile active",
      );
      expect(patchParameterDescription(registeredEditTool(registeredTools))).toContain("Hunk Match: Hash Profile");
      expect(patchParameterDescription(registeredEditTool(registeredTools))).not.toMatch(/\bmarker(?:less)?\b/i);
      expect(patchParameterNames(registeredEditTool(registeredTools))).not.toContain("markerless_selector");
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

function registeredEditTool(tools: RegisteredTool[]): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === "edit");
  if (!tool) throw new Error("edit tool was not registered");
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
