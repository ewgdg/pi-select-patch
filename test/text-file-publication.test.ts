import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directTextFilePublicationBackend } from "../src/text-file-publication.js";

const createTempDirectory = () => mkdtemp(join(tmpdir(), "pi-select-patch-publication-"));
const supportsPosixFileIdentity = process.platform !== "win32";

describe("direct text-file publication backend", () => {
  it.runIf(supportsPosixFileIdentity)("replaces an existing file in place while preserving mode and inode", async () => {
    const directory = await createTempDirectory();
    const path = join(directory, "file.txt");
    await writeFile(path, "old");
    await chmod(path, 0o640);
    const before = await stat(path);

    await directTextFilePublicationBackend.replaceExisting(path, "new");

    const after = await stat(path);
    expect(await readFile(path, "utf8")).toBe("new");
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.ino).toBe(before.ino);
  });

  it.runIf(supportsPosixFileIdentity)("keeps hard-linked targets linked after replacement", async () => {
    const directory = await createTempDirectory();
    const target = join(directory, "target.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(target, "old");
    await link(target, alias);

    await directTextFilePublicationBackend.replaceExisting(target, "new");

    expect(await readFile(alias, "utf8")).toBe("new");
    expect((await stat(target)).ino).toBe((await stat(alias)).ino);
  });

  it.runIf(process.platform !== "win32")("updates a symlink target without replacing the symlink", async () => {
    const directory = await createTempDirectory();
    const target = join(directory, "target.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(target, "old");
    await symlink(target, alias);

    await directTextFilePublicationBackend.replaceExisting(alias, "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it("creates new files exclusively without overwriting an existing target", async () => {
    const directory = await createTempDirectory();
    const path = join(directory, "file.txt");

    await directTextFilePublicationBackend.createNew(path, "first");
    await expect(
      directTextFilePublicationBackend.createNew(path, "second"),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("first");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "does not require a writable parent directory to replace an existing file",
    async () => {
      const directory = await createTempDirectory();
      const path = join(directory, "file.txt");
      await writeFile(path, "old", { mode: 0o600 });
      await chmod(directory, 0o500);
      try {
        await directTextFilePublicationBackend.replaceExisting(path, "new");
        expect(await readFile(path, "utf8")).toBe("new");
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );
});
