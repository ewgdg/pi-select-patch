import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSelectorPatchConfig } from "../src/config.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousProfile = process.env.PI_SELECTOR_PATCH_PROFILE;

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_SELECTOR_PATCH_PROFILE", previousProfile);
});

async function makeAgentDir(config?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pi-selector-patch-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (config !== undefined) {
    const configDir = join(dir, "extensions", "pi-selector-patch");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify(config));
  }
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("selector patch config", () => {
  it("reads profile from extension config.json", async () => {
    await makeAgentDir({ profile: "smart" });

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "smart",
    });
  });

  it("ignores project settings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-selector-patch-project-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ selectorPatch: { profile: "hash" } }),
    );
    await makeAgentDir();

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "classic",
    });
  });

  it("lets environment override global config", async () => {
    await makeAgentDir({ profile: "hash" });
    process.env.PI_SELECTOR_PATCH_PROFILE = "smart";

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "smart",
    });
  });
});
