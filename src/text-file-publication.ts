import { writeFile } from "node:fs/promises";
import { assertExistingTextFileMutationTarget } from "./fs-text.js";

export interface TextFilePublicationBackend {
  replaceExisting(path: string, completeText: string): Promise<void>;
  createNew(path: string, completeText: string): Promise<void>;
}

export const directTextFilePublicationBackend: TextFilePublicationBackend = {
  async replaceExisting(path, completeText) {
    const { realTargetPath } = await assertExistingTextFileMutationTarget(path);
    // Opening the resolved target in place preserves symlinks, hard links, mode, and inode identity.
    await writeFile(realTargetPath, completeText, { encoding: "utf8", flag: "w" });
  },

  async createNew(path, completeText) {
    await writeFile(path, completeText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o666,
    });
  },
};
