import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import piSelectPatch from "../src/index.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousProfile = process.env.PI_SELECT_PATCH_PROFILE;

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
});

describe("Pi session integration", () => {
  it("resolves selector edit when the session allowlist contains only edit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-select-patch-session-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-select-patch-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SELECT_PATCH_PROFILE;

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [piSelectPatch],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      tools: ["edit"],
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });

    try {
      await session.bindExtensions({ mode: "print" });

      expect(session.getActiveToolNames()).toEqual(["edit"]);
      expect(session.getActiveToolNames()).not.toContain("patch");

      const allTools = session.getAllTools();
      expect(allTools.map((tool) => tool.name)).toEqual(["edit"]);
      expect(allTools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "patch" })]));

      const editTool = session.getToolDefinition("edit");
      expect(editTool?.description).toContain("multi-file-capable selector edits");
      expect(editTool?.parameters).toMatchObject({
        properties: expect.objectContaining({
          patch: expect.any(Object),
          patch_file: expect.any(Object),
        }),
      });
    } finally {
      session.dispose();
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
