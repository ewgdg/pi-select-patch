import { describe, expect, it } from "vitest";
import { hashLine, parsePatchInput, parseUniversalPatch, serializeUniversalPatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}${hashLine(content)}`;

describe("universal patch parser", () => {
  it("accepts Codex-like add, update, and delete file sections", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "+world",
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** Delete File: doomed.txt",
      "*** End Patch"
    ].join("\n");

    const parsed = parseUniversalPatch(patch);

    expect(parsed.operations.map((operation) => operation.kind)).toEqual(["add", "update", "delete"]);
    expect(parsed.operations[0]).toMatchObject({ kind: "add", path: "added.txt", lines: ["hello", "world"] });
  });

  it("rejects wrapper-less patches", () => {
    expect(() => parsePatchInput(["@@", row("-", "old"), row("+", "new")].join("\n"))).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects add body lines without Codex plus prefixes", () => {
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "missing prefix", "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(patch)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects delete sections with body lines", () => {
    const withBody = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@", row(" ", "ctx"), "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(withBody)).toThrow("[E_INVALID_PATCH]");
  });

  it("serializes parsed operations as reusable universal patch text", () => {
    const source = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "*** Update File: existing.txt",
      "@@",
      ` ${hashLine("ctx")}│ctx`,
      " ...",
      row("+", "new"),
      "-...",
      " │after",
      "*** Delete File: doomed.txt",
      "*** End Patch"
    ].join("\n");

    const serialized = serializeUniversalPatch(parseUniversalPatch(source).operations);

    expect(serialized).toBe(source);
    expect(parseUniversalPatch(serialized).operations.map((operation) => operation.kind)).toEqual(["add", "update", "delete"]);
  });
});
