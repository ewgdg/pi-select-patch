import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SelectorPatchConfig {
  profile: SelectorPatchProfile;
}

export type SelectorPatchProfile = "explicit" | "smart" | "hash";

export const DEFAULT_PROFILE: SelectorPatchProfile = "smart";

const ENV_PROFILE = "PI_SELECT_PATCH_PROFILE";
const SETTINGS_FILE = "settings.json";
const SETTINGS_KEY = "pi-select-patch";

export async function readSelectorPatchConfig(): Promise<SelectorPatchConfig> {
  const globalSettings = await readConfigJson(globalSettingsPath());
  const configuredProfile = readEnvProfile() ?? readProfile(globalSettings);
  const profile = configuredProfile ?? DEFAULT_PROFILE;
  return { profile };
}

function globalSettingsPath(): string {
  return join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    SETTINGS_FILE,
  );
}

async function readConfigJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function readProfile(settings: unknown): SelectorPatchProfile | undefined {
  if (!isObject(settings)) return undefined;
  const selectorPatch = settings[SETTINGS_KEY];
  if (!isObject(selectorPatch)) return undefined;
  return parseProfile(selectorPatch.profile);
}

function readEnvProfile(): SelectorPatchProfile | undefined {
  return parseProfile(process.env[ENV_PROFILE]);
}

function parseProfile(value: unknown): SelectorPatchProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "explicit" ||
    normalized === "smart" ||
    normalized === "hash"
  )
    return normalized;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
