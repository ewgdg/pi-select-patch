import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, link, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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

export async function resolveNewTextFileTarget(cwd: string, inputPath: string): Promise<string> {
  const absolutePath = resolveToolPath(cwd, inputPath);
  await assertNewTextFileTarget(absolutePath);
  const realParentDirectory = await realpath(dirname(absolutePath)).catch(() => {
    throw new FileTextError(`Parent directory not found: ${dirname(absolutePath)}`);
  });
  return resolve(realParentDirectory, basename(absolutePath));
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
  const { realTargetPath, mode } = await assertExistingTextFileMutationTarget(path);

  // Always write the resolved target so editing a symlink updates its target, not the symlink inode.
  await writeTextFileViaTemp(realTargetPath, text, mode);
}

export async function writeNewTextFileAtomically(path: string, text: string): Promise<void> {
  await assertNewTextFileTarget(path);
  await writeNewTextFileViaTemp(path, text);
}

export async function assertNewTextFileTarget(path: string): Promise<void> {
  const existingStats = await lstat(path).catch(() => undefined);
  if (existingStats) {
    throw new FileTextError(`Add File target already exists: ${path}`);
  }
  await assertParentDirectory(path);
}

export async function assertExistingTextFileMutationTarget(path: string): Promise<{ realTargetPath: string; mode: number }> {
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
  await assertWritableDirectory(dirname(realTargetPath));
  return { realTargetPath, mode: existingStats.mode & 0o777 };
}

export async function deleteExistingRegularFile(path: string): Promise<void> {
  const { realTargetPath } = await assertExistingTextFileMutationTarget(path);
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
  await assertWritableDirectory(parentDirectory);
}

async function assertWritableDirectory(path: string): Promise<void> {
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK).catch(() => {
    throw new FileTextError(`Directory is not readable and writable: ${path}`);
  });
}
async function writeNewTextFileViaTemp(path: string, text: string): Promise<void> {
  const targetDirectory = dirname(path);
  const tempPath = resolve(targetDirectory, `.selector-patch-${process.pid}-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, text, { encoding: "utf8", flag: "wx", mode: 0o666 });
    // Hard-link publish gives no-overwrite atomic creation; final path is never a half-written file.
    await link(tempPath, path);
  } catch (error) {
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}


async function writeTextFileViaTemp(path: string, text: string, mode: number): Promise<void> {
  const targetDirectory = dirname(path);
  const tempPath = resolve(targetDirectory, `.selector-patch-${process.pid}-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, text, { encoding: "utf8", flag: "wx", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
