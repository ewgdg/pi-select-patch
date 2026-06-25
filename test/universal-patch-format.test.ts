import { describe, expect, it } from "vitest";
import { hashLine, parsePatchInput, parseUniversalPatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => `${prefix}${hashLine(content)}│${content}`;

describe("universal patch parser", () => {
  it("accepts Codex-like add, update, and delete file sections", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "+world",
      "*** Update File: existing.txt",
      "@@ @@",
      row("-", "old"),
      row("+", "new"),
      "*** Delete File: doomed.txt",
      "@@ @@",
      row("-", "bye"),
      "*** End Patch"
    ].join("\n");

    const parsed = parseUniversalPatch(patch);

    expect(parsed.operations.map((operation) => operation.kind)).toEqual(["add", "update", "delete"]);
    expect(parsed.operations[0]).toMatchObject({ kind: "add", path: "added.txt", lines: ["hello", "world"] });
  });

  it("retains legacy single-file @@ @@ patches when path is provided", () => {
    const parsed = parsePatchInput(["@@ @@", row("-", "old"), row("+", "new")].join("\n"), "file.txt");
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]).toMatchObject({ kind: "update", path: "file.txt" });
  });

  it("rejects add body lines without Codex plus prefixes", () => {
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "missing prefix", "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(patch)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects delete sections without delete-only hashline evidence", () => {
    const withContext = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@ @@", row(" ", "ctx"), "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(withContext)).toThrow("[E_INVALID_PATCH]");
  });
});
