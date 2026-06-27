import { describe, expect, it } from "vitest";
import { hashLine, parsePatchInput, parseUniversalPatch, serializeUniversalPatch } from "../src/api.js";

const row = (prefix: " " | "=" | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;

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

  it("dedents uniformly indented patch input while preserving locator content indentation", () => {
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
    expect(() => parseUniversalPatch(patch)).toThrow("Line 3: Add File body lines must start with '+'.");
  });

  it("rejects delete sections with body lines", () => {
    const withBody = ["*** Begin Patch", "*** Delete File: doomed.txt", "@@", row("=", "ctx"), "*** End Patch"].join("\n");
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

  it("rejects serializing invalid mixed locator operations", () => {
    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", hash: hashLine("ctx"), content: "ctx" }] }] }
      }
    ])).toThrow("Hash+text locators are not supported");

    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", hash: hashLine("ctx"), combinedSelector: { contains: ["ctx"] } }] }] }
      }
    ])).toThrow("Hash+text locators are not supported");

    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", content: "ctx", combinedSelector: { contains: ["ctx"] } }] }] }
      }
    ])).toThrow("Mixed text locators are not supported");

    expect(() => serializeUniversalPatch([
      {
        kind: "update",
        path: "existing.txt",
        patch: { hunks: [{ ops: [{ kind: "context", combinedSelector: {} }] }] }
      }
    ])).toThrow("requires at least one");
  });
});
