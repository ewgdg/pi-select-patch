import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocatorPatchConfig } from "../src/config.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHashMode = process.env.PI_LOCATOR_PATCH_HASH_MODE;

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_LOCATOR_PATCH_HASH_MODE", previousHashMode);
});

async function makeAgentDir(config?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pi-locator-patch-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (config !== undefined) {
    const configDir = join(dir, "extensions", "pi-locator-patch");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify(config));
  }
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("locator patch config", () => {
  it("reads hash mode from extension config.json", async () => {
    await makeAgentDir({ hashMode: true });

    await expect(readLocatorPatchConfig()).resolves.toEqual({ hashMode: true });
  });

  it("ignores project settings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-locator-patch-project-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ locatorPatch: { hashMode: true } }));
    await makeAgentDir();

    await expect(readLocatorPatchConfig()).resolves.toEqual({ hashMode: false });
  });

  it("lets environment override global config", async () => {
    await makeAgentDir({ hashMode: true });
    process.env.PI_LOCATOR_PATCH_HASH_MODE = "0";

    await expect(readLocatorPatchConfig()).resolves.toEqual({ hashMode: false });
  });
});