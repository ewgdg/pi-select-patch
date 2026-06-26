import { describe, expect, it } from "vitest";
import { hashLine, parsePatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}${hashLine(content)}`;

describe("patch parser", () => {
  it("accepts Codex-style hash-only hunks", () => {
    const patch = parsePatch(["@@", row(" ", "ctx"), row("-", "old"), row("+", "new")].join("\n"));
    expect(patch.hunks[0].ops.map((op) => op.kind)).toEqual(["context", "delete", "insert"]);
  });

  it("accepts context and delete ellipsis operations", () => {
    const patch = parsePatch(["@@", row(" ", "start"), " ...", "-...", row(" ", "end")].join("\n"));
    expect(patch.hunks[0].ops.map((op) => op.kind)).toEqual(["context", "range", "range", "context"]);
    expect(patch.hunks[0].ops.filter((op) => op.kind === "range").map((op) => op.rangeKind)).toEqual(["context", "delete"]);
  });

  it("allows separator in insert operation content", () => {
    const patch = parsePatch(["@@", row("+", "a│b")].join("\n"));
    const [op] = patch.hunks[0].ops;
    expect(op.kind).toBe("insert");
    if (op.kind === "insert") expect(op.content).toBe("a│b");
  });

  it("parses hash-only, hash+text, and text-only context/delete locators", () => {
    const hash = hashLine("ctx");
    const parsed = parsePatch(["@@", ` ${hash}`, `-${hash}│old`, " │ctx text", "-│delete text"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", hash },
      { kind: "delete", hash, content: "old" },
      { kind: "context", content: "ctx text" },
      { kind: "delete", content: "delete text" }
    ]);
  });

  it("parses blank and separator-leading text locators", () => {
    const parsed = parsePatch(["@@", " │", "-││starts"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "" },
      { kind: "delete", content: "│starts" }
    ]);
  });

  it("rejects line-number hunk headers", () => {
    expect(() => parsePatch(`@@ -1,1 +1,1 @@\n${row(" ", "ctx")}`)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects bad locator hashes and read-output-looking insert rows", () => {
    expect(() => parsePatch("@@\n a*c!│ctx")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch("@@\n abc│ctx")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(`@@\n+${hashLine("actual")}│different`)).toThrow("[E_INVALID_PATCH]");
  });

  it("does not treat ASCII pipe as a context/delete separator", () => {
    expect(() => parsePatch(`@@\n ${hashLine("ctx")}|ctx`)).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch("@@\n |ctx")).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects file headers inside Update File sections", () => {
    const patch = ["--- a", "+++ b", "@@", row(" ", "ctx")].join("\n");
    expect(() => parsePatch(patch)).toThrow("[E_INVALID_PATCH]");
  });
});
