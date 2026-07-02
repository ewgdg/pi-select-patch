import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SelectorPatchConfig {
  profile: SelectorPatchProfile;
}

export type SelectorPatchProfile = "classic" | "smart" | "hash";

export const DEFAULT_PROFILE: SelectorPatchProfile = "smart";

const ENV_PROFILE = "PI_SELECT_PATCH_PROFILE";
const EXTENSION_CONFIG_PATH = [
  "extensions",
  "pi-select-patch",
  "config.json",
] as const;

export async function readSelectorPatchConfig(): Promise<SelectorPatchConfig> {
  const globalConfig = await readConfigJson(globalConfigPath());
  const explicitProfile = readEnvProfile() ?? readProfile(globalConfig);
  const profile = explicitProfile ?? DEFAULT_PROFILE;
  return { profile };
}

function globalConfigPath(): string {
  return join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    ...EXTENSION_CONFIG_PATH,
  );
}

async function readConfigJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function readProfile(config: unknown): SelectorPatchProfile | undefined {
  if (!isObject(config)) return undefined;
  return parseProfile(config.profile);
}

function readEnvProfile(): SelectorPatchProfile | undefined {
  return parseProfile(process.env[ENV_PROFILE]);
}

function parseProfile(value: unknown): SelectorPatchProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "classic" ||
    normalized === "smart" ||
    normalized === "hash"
  )
    return normalized;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
