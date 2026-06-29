import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocatorPatchConfig {
  hashMode: boolean;
}

const ENV_HASH_MODE = "PI_LOCATOR_PATCH_HASH_MODE";
const EXTENSION_CONFIG_PATH = ["extensions", "pi-locator-patch", "config.json"] as const;

export async function readLocatorPatchConfig(): Promise<LocatorPatchConfig> {
  const globalConfig = await readConfigJson(globalConfigPath());
  return { hashMode: readEnvHashMode() ?? readHashMode(globalConfig) ?? false };
}

function globalConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), ...EXTENSION_CONFIG_PATH);
}

async function readConfigJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function readHashMode(config: unknown): boolean | undefined {
  if (!isObject(config)) return undefined;
  return typeof config.hashMode === "boolean" ? config.hashMode : undefined;
}

function readEnvHashMode(): boolean | undefined {
  const value = process.env[ENV_HASH_MODE]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on", "hash"].includes(value)) return true;
  if (["0", "false", "no", "off", "plain"].includes(value)) return false;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}