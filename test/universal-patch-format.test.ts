import { describe, expect, it } from "vitest";
import { copyUniversalPatchInputTail, hashLine, parsePatchInput, parseUniversalPatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;

describe("universal patch parser", () => {
  it("accepts Codex-like add and update file sections", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "+world",
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** End Patch"
    ].join("\n");

    const parsed = parseUniversalPatch(patch);

    expect(parsed.operations.map((operation) => operation.kind)).toEqual(["add", "update"]);
    expect(parsed.operations[0]).toMatchObject({ kind: "add", path: "added.txt", lines: ["hello", "world"] });
  });

  it("accepts repeated update sections for the same path in authored order", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      row(" ", "first"),
      row("+", "second"),
      "*** Update File: existing.txt",
      "@@",
      row(" ", "second"),
      row("+", "third"),
      "*** End Patch"
    ].join("\n");

    const parsed = parseUniversalPatch(patch);

    expect(parsed.operations.map((operation) => operation.path)).toEqual(["existing.txt", "existing.txt"]);
  });

  it("accepts file operation sections without patch boundaries", () => {
    const parsed = parsePatchInput([
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      row("+", "new")
    ].join("\n"));

    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]).toMatchObject({ kind: "update", path: "existing.txt" });
  });

  it("accepts a trailing closing boundary without an opening boundary", () => {
    const closingOnly = [
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** End Patch"
    ].join("\n");

    const parsed = parsePatchInput(closingOnly);

    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]).toMatchObject({ kind: "update", path: "existing.txt" });
    expect(copyUniversalPatchInputTail(parsed, 0)).toBe([
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      row("+", "new")
    ].join("\n"));
  });

  it("rejects stray patch boundaries", () => {
    const nestedClosing = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      "*** End Patch",
      "*** End Patch"
    ].join("\n");

    expect(() => parsePatchInput(nestedClosing)).toThrow("Line 5: Unexpected patch boundary.");
  });

  it("keeps input line numbers for indented boundary-free patches", () => {
    const patch = `
      
      *** Add File: added.txt
      missing prefix
    `;

    expect(() => parsePatchInput(patch)).toThrow("Line 4: Add File body lines must start with +.");
  });

  it("dedents uniformly indented patch input while preserving selector content indentation", () => {
    const parsed = parsePatchInput(`
      *** Begin Patch
      *** Add File: added.txt
      +    indented add content
      *** Update File: existing.txt
      @@
       :  old context
      +  new content
      *** End Patch
    `);

    expect(parsed.operations[0]).toMatchObject({ kind: "add", path: "added.txt", lines: ["    indented add content"] });
    expect(parsed.operations[1]).toMatchObject({
      kind: "update",
      patch: {
        hunks: [{
          ops: [
            { kind: "context", content: "  old context" },
            { kind: "insert", content: "  new content" }
          ]
        }]
      }
    });
  });

  it("parses leading-space context rows after wrapper dedent", () => {
    const parsed = parsePatchInput(`
      *** Begin Patch
      *** Update File: existing.txt
      @@
       :aaa
      *** End Patch
    `);

    expect(parsed.operations[0]).toMatchObject({
      kind: "update",
      patch: { hunks: [{ ops: [{ kind: "context", content: "aaa" }] }] }
    });
  });

  it("rejects add body lines without Codex plus prefixes", () => {
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "missing prefix", "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(patch)).toThrow("Line 3: Add File body lines must start with +.");
  });

  it("rejects Delete File sections", () => {
    const withBody = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@", row(" ", "ctx"), "*** End Patch"].join("\n");
    const withoutBody = ["*** Begin Patch", "*** Delete File: doomed.txt", "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(withoutBody)).toThrow("Line 2: Delete File sections are not supported.");
    expect(() => parseUniversalPatch(withBody)).toThrow("Line 2: Delete File sections are not supported.");
  });

  it("copies authored retry patch tails without serializing parsed operations", () => {
    const source = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "*** Update File: existing.txt",
      "@@ @3...9",
      row(" ", "ctx"),
      row("-", "old"),
      " ^ctx",
      " *middle",
      ' ?{"prefix":"pre","contains":["mid"],"suffix":"suf"}',
      " ...",
      row("+", "new"),
      "-...",
      " $after",
      "*** End Patch"
    ].join("\n");

    const parsed = parseUniversalPatch(source);

    expect(copyUniversalPatchInputTail(parsed, 1)).toBe([
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@ @3...9",
      row(" ", "ctx"),
      row("-", "old"),
      " ^ctx",
      " *middle",
      ' ?{"prefix":"pre","contains":["mid"],"suffix":"suf"}',
      " ...",
      row("+", "new"),
      "-...",
      " $after",
      "*** End Patch"
    ].join("\n"));
  });

  it("accepts leading-space context rows inside universal patches", () => {
    const source = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      " :literal context",
      "*** End Patch"
    ].join("\n");

    const [operation] = parseUniversalPatch(source).operations;
    expect(operation).toMatchObject({
      kind: "update",
      patch: { hunks: [{ ops: [{ kind: "context", content: "literal context" }] }] }
    });
  });

});
