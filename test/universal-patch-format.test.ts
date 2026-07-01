import { describe, expect, it } from "vitest";
import { hashLine, parsePatchInput, parseUniversalPatch, serializeUniversalPatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;

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

  it("rejects stray patch boundaries", () => {
    const closingOnly = [
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      row("+", "new"),
      "*** End Patch"
    ].join("\n");
    const nestedClosing = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      row("-", "old"),
      "*** End Patch",
      "*** End Patch"
    ].join("\n");

    expect(() => parsePatchInput(closingOnly)).toThrow("Line 5: Patch boundary is incomplete.");
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

  it("rejects delete sections with body lines", () => {
    const withBody = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@", row(" ", "ctx"), "*** End Patch"].join("\n");
    expect(() => parseUniversalPatch(withBody)).toThrow("Line 3: Delete File sections must not include hunks or body lines.");
  });

  it("serializes parsed operations as reusable universal patch text", () => {
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
      "*** Delete File: doomed.txt",
      "*** End Patch"
    ].join("\n");

    const serialized = serializeUniversalPatch(parseUniversalPatch(source).operations);

    expect(serialized).toBe(source);
    expect(serialized).toContain("@@ @3...9");
    expect(serialized).toContain(` #${hashLine("ctx")}`);
    expect(serialized).toContain(`-#${hashLine("old")}`);
    expect(serialized).toContain(" ^ctx");
    expect(serialized).toContain(" *middle");
    expect(serialized).toContain(' ?{"prefix":"pre","contains":["mid"],"suffix":"suf"}');
    expect(serialized).toContain(" $after");
    expect(parseUniversalPatch(serialized).operations.map((operation) => operation.kind)).toEqual(["add", "update", "delete"]);
  });

  it("serializes hash profile retry patches with unified-diff context operators", () => {
    const hash = hashLine("old").slice(0, 3);
    const serialized = serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", hash }, { kind: "range", rangeKind: "context" }, { kind: "delete", hash }, { kind: "range", rangeKind: "delete" }] }] }
      }
    ], { profile: "hash" });

    expect(serialized).toContain(`@@\n ${hash}\n ...\n-${hash}\n-...`);
    expect(parseUniversalPatch(serialized, undefined, { profile: "hash" }).operations[0]).toMatchObject({ kind: "update" });
  });

  it("serializes smart profile retry patches with unified-diff context operators", () => {
    const serialized = serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", content: "target", smart: true }, { kind: "range", rangeKind: "context" }, { kind: "delete", content: "old", smart: true }, { kind: "range", rangeKind: "delete" }] }] }
      }
    ], { profile: "smart" });

    expect(serialized).toContain("@@\n target\n ...\n-old\n-...");
    expect(parseUniversalPatch(serialized, undefined, { profile: "smart" }).operations[0]).toMatchObject({ kind: "update" });
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

  it("round-trips exact, prefix, contains, combined, and suffix text selectors with marker characters", () => {
    const serialized = serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: {
          hunks: [{
            ops: [
              { kind: "context", content: "^literal", textSelector: "exact" },
              { kind: "delete", content: "literal$", textSelector: "exact" },
              { kind: "context", content: "^suffix", textSelector: "suffix" },
              { kind: "context", content: "middle", textSelector: "contains" },
              { kind: "delete", combinedSelector: { prefix: "$prefix", contains: ["middle"], suffix: "^suffix" } },
              { kind: "delete", content: "$prefix", textSelector: "prefix" }
            ]
          }]
        }
      }
    ]);

    const [operation] = parseUniversalPatch(serialized).operations;
    expect(operation).toMatchObject({
      kind: "update",
      patch: {
        hunks: [{
          ops: [
            { kind: "context", content: "^literal", textSelector: "exact" },
            { kind: "delete", content: "literal$", textSelector: "exact" },
            { kind: "context", content: "^suffix", textSelector: "suffix" },
            { kind: "context", content: "middle", textSelector: "contains" },
            { kind: "delete", combinedSelector: { prefix: "$prefix", contains: ["middle"], suffix: "^suffix" } },
            { kind: "delete", content: "$prefix", textSelector: "prefix" }
          ]
        }]
      }
    });
  });

  it("rejects serializing invalid mixed selector operations", () => {
    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", hash: hashLine("ctx"), content: "ctx" }] }] }
      }
    ])).toThrow("Hash+text selectors are not supported");

    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", hash: hashLine("ctx"), combinedSelector: { contains: ["ctx"] } }] }] }
      }
    ])).toThrow("Hash+text selectors are not supported");

    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", content: "ctx", combinedSelector: { contains: ["ctx"] } }] }] }
      }
    ])).toThrow("Mixed text selectors are not supported");

    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", combinedSelector: {} }] }] }
      }
    ])).toThrow("requires at least one");
  });

  it("round-trips smart selectors in universal patch serialization", () => {
    const source = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      " ~smart context",
      "-~smart delete",
      "+~literal insert",
      "*** End Patch"
    ].join("\n");

    const serialized = serializeUniversalPatch(parseUniversalPatch(source).operations);

    expect(serialized).toBe(source);
    const [operation] = parseUniversalPatch(serialized).operations;
    expect(operation).toMatchObject({
      kind: "update",
      patch: { hunks: [{ ops: [
        { kind: "context", content: "smart context", smart: true },
        { kind: "delete", content: "smart delete", smart: true },
        { kind: "insert", content: "~literal insert" }
      ] }] }
    });
  });

  it("serializes empty smart selectors", () => {
    const source = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      " ~",
      "-~",
      "*** End Patch"
    ].join("\n");

    expect(serializeUniversalPatch(parseUniversalPatch(source).operations)).toBe(source);
  });

});
