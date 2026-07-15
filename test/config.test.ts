import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSelectorPatchConfig } from "../src/config.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousProfile = process.env.PI_SELECT_PATCH_PROFILE;
const previousAnchorMode = process.env.PI_SELECT_PATCH_ANCHOR_MODE;

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_SELECT_PATCH_PROFILE", previousProfile);
  restoreEnv("PI_SELECT_PATCH_ANCHOR_MODE", previousAnchorMode);
});

async function makeAgentDir(selectorPatchConfig?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pi-select-patch-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (selectorPatchConfig !== undefined) {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ "pi-select-patch": selectorPatchConfig }),
    );
  }
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("select patch config", () => {
  it("reads profile from global settings.json", async () => {
    await makeAgentDir({ profile: "hash" });

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "hash",
      anchorMode: "strict",
    });
  });

  it("reads the explicit selector profile", async () => {
    await makeAgentDir({ profile: "explicit" });

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "explicit",
      anchorMode: "strict",
    });
  });

  it("ignores project settings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-select-patch-project-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-select-patch": { profile: "hash" } }),
    );
    await makeAgentDir();

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "smart",
      anchorMode: "strict",
    });
  });

  it("lets environment override global config", async () => {
    await makeAgentDir({ profile: "hash" });
    process.env.PI_SELECT_PATCH_PROFILE = "smart";

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "smart",
      anchorMode: "strict",
    });
  });


  it("reads tolerant anchor mode from global settings.json", async () => {
    await makeAgentDir({ anchorMode: "tolerant" });

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "smart",
      anchorMode: "tolerant",
    });
  });

  it("lets the anchor mode environment variable override global config", async () => {
    await makeAgentDir({ anchorMode: "strict" });
    process.env.PI_SELECT_PATCH_ANCHOR_MODE = "tolerant";

    await expect(readSelectorPatchConfig()).resolves.toEqual({
      profile: "smart",
      anchorMode: "tolerant",
    });
  });

  it("rejects invalid configured anchor mode", async () => {
    await makeAgentDir({ anchorMode: "unsafe" });

    await expect(readSelectorPatchConfig()).rejects.toThrow("Invalid pi-select-patch anchor mode");
  });

  it("rejects invalid environment anchor mode", async () => {
    await makeAgentDir({ anchorMode: "tolerant" });
    process.env.PI_SELECT_PATCH_ANCHOR_MODE = "unsafe";

    await expect(readSelectorPatchConfig()).rejects.toThrow("Invalid pi-select-patch anchor mode");
  });
});
