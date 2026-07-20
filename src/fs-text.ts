import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { FileTextError } from "./errors.js";

export interface ReadTextFileResult {
  path: string;
  text: string;
}

export interface ReadTextFileOptions {
  writable?: boolean;
  displayPath?: string;
}

const MAX_TEXT_FILE_ERROR_PATH_CHARACTERS = 240;
const TEXT_FILE_ERROR_PATH_OMISSION_MARKER = "...";

export function resolveToolPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath.replace(/^@/, ""));
}

export async function resolveExistingRealPath(cwd: string, inputPath: string): Promise<string> {
  const absolutePath = resolveToolPath(cwd, inputPath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    throw createTextFilePathResolutionError(inputPath, error);
  }
}

export async function resolveNewTextFileTarget(cwd: string, inputPath: string): Promise<string> {
  const absolutePath = resolveToolPath(cwd, inputPath);
  await assertNewTextFileTarget(absolutePath);
  const realParentDirectory = await realpath(dirname(absolutePath)).catch(() => {
    throw new FileTextError(`Parent directory not found: ${dirname(absolutePath)}`);
  });
  return resolve(realParentDirectory, basename(absolutePath));
}

export async function readExistingTextFile(path: string, options: ReadTextFileOptions = {}): Promise<ReadTextFileResult> {
  const rawDisplayPath = options.displayPath ?? path;
  const displayPath = formatTextFileErrorPath(rawDisplayPath);
  const realTargetPath = await realpath(path).catch((error: unknown) => {
    throw createTextFilePathResolutionError(rawDisplayPath, error);
  });

  const stats = await stat(realTargetPath).catch((error: unknown) => {
    throw fileOperationError("inspect", displayPath, error);
  });
  if (!stats.isFile()) {
    throw new FileTextError(`Path is not a regular text file: ${displayPath}`);
  }

  const mode = options.writable ? constants.R_OK | constants.W_OK : constants.R_OK;
  await access(realTargetPath, mode).catch(() => {
    throw new FileTextError(options.writable ? `File is not readable and writable: ${displayPath}` : `File is not readable: ${displayPath}`);
  });

  const buffer = await readFile(realTargetPath).catch((error: unknown) => {
    throw fileOperationError("read", displayPath, error);
  });
  if (buffer.includes(0)) {
    throw new FileTextError(`Binary file rejected because it contains NUL bytes: ${displayPath}`);
  }

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    return { path: realTargetPath, text: decoder.decode(buffer) };
  } catch (error) {
    throw new FileTextError(`Invalid UTF-8 text file: ${displayPath}`);
  }
}

export function createTextFilePathResolutionError(displayPath: string, error: unknown): FileTextError {
  const boundedDisplayPath = formatTextFileErrorPath(displayPath);
  const code = filesystemErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FileTextError(`File not found: ${boundedDisplayPath}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FileTextError(`File is inaccessible: ${boundedDisplayPath}`);
  }
  return new FileTextError(`Could not resolve text file: ${boundedDisplayPath} (${code ?? "filesystem error"})`);
}

function fileOperationError(operation: "inspect" | "read", displayPath: string, error: unknown): FileTextError {
  const code = filesystemErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FileTextError(`File not found: ${displayPath}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FileTextError(`File is inaccessible: ${displayPath}`);
  }
  return new FileTextError(`Could not ${operation} text file: ${displayPath} (${code ?? "filesystem error"})`);
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function formatTextFileErrorPath(path: string): string {
  const singleLinePath = path.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  if (singleLinePath.length <= MAX_TEXT_FILE_ERROR_PATH_CHARACTERS) {
    return singleLinePath;
  }
  const omittedCharacterCount = singleLinePath.length - MAX_TEXT_FILE_ERROR_PATH_CHARACTERS;
  return `${singleLinePath.slice(0, MAX_TEXT_FILE_ERROR_PATH_CHARACTERS)}${TEXT_FILE_ERROR_PATH_OMISSION_MARKER} ${omittedCharacterCount} chars omitted`;
}

export async function assertNewTextFileTarget(path: string): Promise<void> {
  const existingStats = await lstat(path).catch(() => undefined);
  if (existingStats) {
    throw new FileTextError(`Add File target already exists: ${path}`);
  }
  await assertParentDirectory(path);
}

export async function assertExistingTextFileMutationTarget(path: string): Promise<{ realTargetPath: string }> {
  const realTargetPath = await realpath(path).catch(() => {
    throw new FileTextError(`File not found: ${path}`);
  });
  const existingStats = await stat(realTargetPath);
  if (!existingStats.isFile()) {
    throw new FileTextError(`Path is not a regular text file: ${path}`);
  }
  await access(realTargetPath, constants.R_OK | constants.W_OK).catch(() => {
    throw new FileTextError(`File is not readable and writable: ${path}`);
  });
  return { realTargetPath };
}

export async function assertNotDirectory(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats?.isDirectory()) {
    throw new FileTextError(`Directories are not supported: ${path}`);
  }
}

async function assertParentDirectory(path: string): Promise<void> {
  const parentDirectory = dirname(path);
  const parentStats = await stat(parentDirectory).catch(() => {
    throw new FileTextError(`Parent directory not found: ${parentDirectory}`);
  });
  if (!parentStats.isDirectory()) {
    throw new FileTextError(`Parent path is not a directory: ${parentDirectory}`);
  }
  await assertWritableDirectory(parentDirectory);
}

async function assertWritableDirectory(path: string): Promise<void> {
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK).catch(() => {
    throw new FileTextError(`Directory is not readable and writable: ${path}`);
  });
}
