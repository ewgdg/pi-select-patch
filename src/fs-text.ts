import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { FileTextError } from "./errors.js";

export interface ReadTextFileResult {
  path: string;
  text: string;
}

export interface ReadTextFileOptions {
  writable?: boolean;
}

export function resolveToolPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath.replace(/^@/, ""));
}

export async function resolveExistingRealPath(cwd: string, inputPath: string): Promise<string> {
  const absolutePath = resolveToolPath(cwd, inputPath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    throw new FileTextError(`File not found: ${inputPath}`);
  }
}

export async function readExistingTextFile(path: string, options: ReadTextFileOptions = {}): Promise<ReadTextFileResult> {
  const realTargetPath = await realpath(path).catch(() => {
    throw new FileTextError(`File not found: ${path}`);
  });

  const stats = await stat(realTargetPath);
  if (!stats.isFile()) {
    throw new FileTextError(`Path is not a regular text file: ${path}`);
  }

  const mode = options.writable ? constants.R_OK | constants.W_OK : constants.R_OK;
  await access(realTargetPath, mode).catch(() => {
    throw new FileTextError(options.writable ? `File is not readable and writable: ${path}` : `File is not readable: ${path}`);
  });

  const buffer = await readFile(realTargetPath);
  if (buffer.includes(0)) {
    throw new FileTextError(`Binary file rejected because it contains NUL bytes: ${path}`);
  }

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    return { path: realTargetPath, text: decoder.decode(buffer) };
  } catch (error) {
    throw new FileTextError(`Invalid UTF-8 text file: ${path}`);
  }
}

export async function writeTextFileAtomically(path: string, text: string): Promise<void> {
  const realTargetPath = await realpath(path).catch(() => {
    throw new FileTextError(`File not found: ${path}`);
  });
  const existingStats = await stat(realTargetPath);
  if (!existingStats.isFile()) {
    throw new FileTextError(`Path is not a regular text file: ${path}`);
  }

  // Always write the resolved target so editing a symlink updates its target, not the symlink inode.
  await writeTextFileViaTemp(realTargetPath, text, existingStats.mode & 0o777);
}

export async function writeNewTextFileAtomically(path: string, text: string): Promise<void> {
  await assertNewTextFileTarget(path);
  await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o666 });
}

export async function assertNewTextFileTarget(path: string): Promise<void> {
  const existingStats = await lstat(path).catch(() => undefined);
  if (existingStats) {
    throw new FileTextError(`Add File target already exists: ${path}`);
  }
  await assertParentDirectory(path);
}

export async function deleteExistingRegularFile(path: string): Promise<void> {
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
  await unlink(realTargetPath);
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
  await access(parentDirectory, constants.R_OK | constants.W_OK).catch(() => {
    throw new FileTextError(`Parent directory is not writable: ${parentDirectory}`);
  });
}

async function writeTextFileViaTemp(path: string, text: string, mode: number): Promise<void> {
  const targetDirectory = dirname(path);
  const tempPath = resolve(targetDirectory, `.hashline-patch-${process.pid}-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, text, { encoding: "utf8", flag: "wx", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
