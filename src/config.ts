import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnchorMode } from "./apply.js";

export interface SelectorPatchConfig {
  profile: SelectorPatchProfile;
  anchorMode: AnchorMode;
}

export type SelectorPatchProfile = "explicit" | "smart" | "hash";

export const DEFAULT_PROFILE: SelectorPatchProfile = "smart";
export const DEFAULT_ANCHOR_MODE: AnchorMode = "strict";

const ENV_PROFILE = "PI_SELECT_PATCH_PROFILE";
const ENV_ANCHOR_MODE = "PI_SELECT_PATCH_ANCHOR_MODE";
const SETTINGS_FILE = "settings.json";
const SETTINGS_KEY = "pi-select-patch";

export async function readSelectorPatchConfig(): Promise<SelectorPatchConfig> {
  const globalSettings = await readConfigJson(globalSettingsPath());
  const configuredProfile = readEnvProfile() ?? readProfile(globalSettings);
  const profile = configuredProfile ?? DEFAULT_PROFILE;
  const anchorMode = readEnvAnchorMode() ?? readAnchorMode(globalSettings) ?? DEFAULT_ANCHOR_MODE;
  return { profile, anchorMode };
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
  const selectorPatch = selectorPatchSettings(settings);
  return selectorPatch ? parseProfile(selectorPatch.profile) : undefined;
}

function readEnvProfile(): SelectorPatchProfile | undefined {
  return parseProfile(process.env[ENV_PROFILE]);
}

function readAnchorMode(settings: unknown): AnchorMode | undefined {
  const selectorPatch = selectorPatchSettings(settings);
  if (!selectorPatch || selectorPatch.anchorMode === undefined) return undefined;
  return parseAnchorMode(selectorPatch.anchorMode, "global settings");
}

function readEnvAnchorMode(): AnchorMode | undefined {
  const value = process.env[ENV_ANCHOR_MODE];
  if (value === undefined) return undefined;
  return parseAnchorMode(value, ENV_ANCHOR_MODE);
}

function parseProfile(value: unknown): SelectorPatchProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "explicit" ||
    normalized === "smart" ||
    normalized === "hash"
  ) return normalized;
  return undefined;
}

function parseAnchorMode(value: unknown, source: string): AnchorMode {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "strict" || normalized === "tolerant") return normalized;
  }
  throw new Error(`Invalid pi-select-patch anchor mode from ${source}. Expected \"strict\" or \"tolerant\".`);
}

function selectorPatchSettings(settings: unknown): Record<string, unknown> | undefined {
  if (!isObject(settings)) return undefined;
  const selectorPatch = settings[SETTINGS_KEY];
  return isObject(selectorPatch) ? selectorPatch : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
