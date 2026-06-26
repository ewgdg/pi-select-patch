import { describe, expect, it } from "vitest";
import { hashLine, parsePatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashLine(content)}`;

describe("patch parser", () => {
  it("accepts hunk anchor hints", () => {
    const parsed = parsePatch(["@@ @12", " :ctx", "@@ @3...7", " :other"].join("\n"));

    expect(parsed.hunks[0]).toMatchObject({ anchorHint: { line: 12 } });
    expect(parsed.hunks[0].ops).toMatchObject([{ kind: "context", content: "ctx" }]);
    expect(parsed.hunks[1]).toMatchObject({ anchorHint: { line: 3, endLine: 7 } });
    expect(parsed.hunks[1].ops).toMatchObject([{ kind: "context", content: "other" }]);
  });

  it("rejects malformed hunk anchor hints", () => {
    for (const header of ["@@ @0", "@@ @-1", "@@ @abc", "@@ @12 extra", "@@ @ 12", "@@ @1...0", "@@ @3...2", "@@ @1...abc", "@@ @1 ...3", "@@ @1... 3"]) {
      expect(() => parsePatch([header, " :ctx"].join("\n"))).toThrow("[E_INVALID_PATCH]");
    }
  });

  it("accepts hash context/delete hunks with dedicated hash prefixes", () => {
    const patch = parsePatch(["@@", row(" ", "ctx"), row("-", "old"), row("+", "new")].join("\n"));
    expect(patch.hunks[0].ops).toMatchObject([
      { kind: "context", hash: hashLine("ctx") },
      { kind: "delete", hash: hashLine("old") },
      { kind: "insert", content: "new" }
    ]);
  });

  it("accepts context and delete ellipsis operations", () => {
    const patch = parsePatch(["@@", row(" ", "start"), " ...", "-...", row(" ", "end")].join("\n"));
    expect(patch.hunks[0].ops.map((op) => op.kind)).toEqual(["context", "range", "range", "context"]);
    expect(patch.hunks[0].ops.filter((op) => op.kind === "range").map((op) => op.rangeKind)).toEqual(["context", "delete"]);
  });

  it("parses text ellipsis rows as literal locators", () => {
    const parsed = parsePatch(["@@", " :...", "-:..."].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "..." },
      { kind: "delete", content: "..." }
    ]);
  });

  it("rejects bare ellipsis rows", () => {
    expect(() => parsePatch("@@\n...")).toThrow("[E_INVALID_PATCH]");
  });

  it("allows separator in insert operation content", () => {
    const patch = parsePatch(["@@", row("+", "a│b")].join("\n"));
    const [op] = patch.hunks[0].ops;
    expect(op.kind).toBe("insert");
    if (op.kind === "insert") expect(op.content).toBe("a│b");
  });

  it("parses text context/delete locators literally", () => {
    const parsed = parsePatch(["@@", " :ctx text", "-:delete text", " :│starts", "-:│delete pipe"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "ctx text" },
      { kind: "delete", content: "delete text" },
      { kind: "context", content: "│starts" },
      { kind: "delete", content: "│delete pipe" }
    ]);
  });

  it("parses blank text context/delete locators", () => {
    const parsed = parsePatch(["@@", " :", "-:"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "" },
      { kind: "delete", content: "" }
    ]);
  });

  it("rejects legacy bare text and hash locator operations", () => {
    const hash = hashLine("ctx");

    expect(() => parsePatch(["@@", ` ${hash}`].join("\n"))).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(["@@", `-${hash}`].join("\n"))).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(["@@", " bare text"].join("\n"))).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(["@@", "-bare text"].join("\n"))).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(["@@", `=${hash}`].join("\n"))).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(["@@", `~${hash}`].join("\n"))).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects line-number hunk headers", () => {
    expect(() => parsePatch(`@@ -1,1 +1,1 @@\n${row(" ", "ctx")}`)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects bad dedicated hash operations", () => {
    expect(() => parsePatch("@@\n #abc")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch("@@\n-#a*c!")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(`@@\n #${hashLine("ctx")}│ctx`)).toThrow("[E_INVALID_PATCH]");
  });

  it("treats hashline-looking insert rows as literal content", () => {
    const content = `${hashLine("actual")}│different`;
    const patch = parsePatch(`@@\n+${content}`);
    const [op] = patch.hunks[0].ops;
    expect(op.kind).toBe("insert");
    if (op.kind === "insert") expect(op.content).toBe(content);
  });

  it("rejects deferred prefix selectors clearly", () => {
    expect(() => parsePatch("@@\n ^prefix")).toThrow("Prefix selectors are not supported yet");
    expect(() => parsePatch("@@\n-^prefix")).toThrow("Prefix selectors are not supported yet");
  });

  it("rejects unsupported operation prefixes", () => {
    expect(() => parsePatch("@@\n|ctx")).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects file headers inside Update File sections", () => {
    const patch = ["--- a", "+++ b", "@@", row(" ", "ctx")].join("\n");
    expect(() => parsePatch(patch)).toThrow("[E_INVALID_PATCH]");
  });
});
