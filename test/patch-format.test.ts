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

  it("accepts 3- and 4-character hash context/delete hunks with dedicated hash prefixes", () => {
    const patch = parsePatch(["@@", ` #${hashLine("ctx").slice(0, 3)}`, row("-", "old"), row("+", "new")].join("\n"));
    expect(patch.hunks[0].ops).toMatchObject([
      { kind: "context", hash: hashLine("ctx").slice(0, 3) },
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

  it("accepts bare ellipsis rows as omitted-space context ranges", () => {
    const parsed = parsePatch("@@\n...");

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "range", rangeKind: "context" }
    ]);
  });

  it("allows separator in insert operation content", () => {
    const patch = parsePatch(["@@", row("+", "a│b")].join("\n"));
    const [op] = patch.hunks[0].ops;
    expect(op.kind).toBe("insert");
    if (op.kind === "insert") expect(op.content).toBe("a│b");
  });

  it("parses text context/delete locators literally", () => {
    const parsed = parsePatch(["@@", " :ctx text", "-:delete text", " :│starts", "-:│delete pipe", " :  indented"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "ctx text" },
      { kind: "delete", content: "delete text" },
      { kind: "context", content: "│starts" },
      { kind: "delete", content: "│delete pipe" },
      { kind: "context", content: "  indented" }
    ]);
  });


  it("parses prefix, contains, and suffix text context/delete locators", () => {
    const parsed = parsePatch(["@@", " ^function parse", "-^old value", " *needle value", "-*delete needle", " $);", "-$old suffix"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "function parse", textSelector: "prefix" },
      { kind: "delete", content: "old value", textSelector: "prefix" },
      { kind: "context", content: "needle value", textSelector: "contains" },
      { kind: "delete", content: "delete needle", textSelector: "contains" },
      { kind: "context", content: ");", textSelector: "suffix" },
      { kind: "delete", content: "old suffix", textSelector: "suffix" }
    ]);
  });

  it("parses combined text context/delete locators and normalizes contains", () => {
    const parsed = parsePatch([
      "@@",
      ' ?{"prefix":"function ","contains":"parse","suffix":" {"}',
      '-?{"contains":["old","value"]}'
    ].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", combinedSelector: { prefix: "function ", contains: ["parse"], suffix: " {" } },
      { kind: "delete", combinedSelector: { contains: ["old", "value"] } }
    ]);
  });

  it("rejects malformed combined text locators", () => {
    for (const selector of [
      ' ?not-json',
      ' ?[]',
      ' ?"text"',
      ' ?{}',
      ' ?{"unknown":"x"}',
      ' ?{"prefix":""}',
      ' ?{"prefix":1}',
      ' ?{"suffix":""}',
      ' ?{"contains":""}',
      ' ?{"contains":[]}',
      ' ?{"contains":["ok",""]}',
      ' ?{"contains":[1]}'
    ]) {
      expect(() => parsePatch(["@@", selector].join("\n"))).toThrow("[E_INVALID_PATCH]");
    }
  });

  it("keeps caret, star, and dollar text selectors exact behind colon", () => {
    const parsed = parsePatch(["@@", " :^literal", "-:*literal", " :cost$"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "^literal", textSelector: "exact" },
      { kind: "delete", content: "*literal", textSelector: "exact" },
      { kind: "context", content: "cost$", textSelector: "exact" }
    ]);
  });

  it("rejects empty prefix, contains, and suffix text locators", () => {
    expect(() => parsePatch("@@\n ^")).toThrow("Line 2: Malformed context prefix locator. Expected non-empty text after ^.");
    expect(() => parsePatch("@@\n-^" )).toThrow("Line 2: Malformed delete prefix locator. Expected non-empty text after ^.");
    expect(() => parsePatch("@@\n *")).toThrow("Line 2: Malformed context contains locator. Expected non-empty text after *.");
    expect(() => parsePatch("@@\n-*")).toThrow("Line 2: Malformed delete contains locator. Expected non-empty text after *.");
    expect(() => parsePatch("@@\n $")).toThrow("Line 2: Malformed context suffix locator. Expected non-empty text after $.");
    expect(() => parsePatch("@@\n-$")).toThrow("Line 2: Malformed delete suffix locator. Expected non-empty text after $.");
  });

  it("parses blank text context/delete locators", () => {
    const parsed = parsePatch(["@@", " :", "-:"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "" },
      { kind: "delete", content: "" }
    ]);
  });

  it("accepts leading-space context selector rows", () => {
    const parsed = parsePatch(["@@", " :literal context", " ", " ^foo", " #abc", " ...", " :x"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "literal context", textSelector: "exact" },
      { kind: "context", content: "", textSelector: "exact" },
      { kind: "context", content: "foo", textSelector: "prefix" },
      { kind: "context", hash: "abc" },
      { kind: "range", rangeKind: "context" },
      { kind: "context", content: "x", textSelector: "exact" }
    ]);
  });

  it("accepts omitted-space context locator rows", () => {
    const parsed = parsePatch(["@@", ":literal context", ":", "^foo", "#abc", "*needle", "$tail", '?{"contains":"done"}', "..."].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "literal context", textSelector: "exact" },
      { kind: "context", content: "", textSelector: "exact" },
      { kind: "context", content: "foo", textSelector: "prefix" },
      { kind: "context", hash: "abc" },
      { kind: "context", content: "needle", textSelector: "contains" },
      { kind: "context", content: "tail", textSelector: "suffix" },
      { kind: "context", combinedSelector: { contains: ["done"] } },
      { kind: "range", rangeKind: "context" }
    ]);
    expect(parsed.hunks[0].ops).not.toContainEqual(expect.objectContaining({ unifiedDiff: true }));
  });

  it("parses unified-diff rows when locator markers are missing", () => {
    const hash = hashLine("ctx");
    const parsed = parsePatch(["@@", ` ${hash}`, "", `-${hash}`, "+new", " context", "-"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: hash, textSelector: "exact" },
      { kind: "context", content: "", textSelector: "exact", unifiedDiff: true },
      { kind: "delete", content: hash, textSelector: "exact" },
      { kind: "insert", content: "new" },
      { kind: "context", content: "context", textSelector: "exact" },
      { kind: "delete", content: "", textSelector: "exact" }
    ]);
  });

  it("rejects bare unified-diff context rows", () => {
    expect(() => parsePatch("@@\ncontext")).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects line-number hunk headers", () => {
    expect(() => parsePatch(`@@ -1,1 +1,1 @@\n${row(" ", "ctx")}`)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects bad dedicated hash operations", () => {
    expect(() => parsePatch("@@\n #ab")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch("@@\n #abcde")).toThrow("[E_INVALID_PATCH]");
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

  it("rejects unsupported operation prefixes", () => {
    expect(() => parsePatch("@@\n|ctx")).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects file headers inside Update File sections", () => {
    const patch = ["--- a", "+++ b", "@@", row(" ", "ctx")].join("\n");
    expect(() => parsePatch(patch)).toThrow("[E_INVALID_PATCH]");
  });

  it("accepts smart context/delete locators and leaves smart-looking inserts literal", () => {
    const parsed = parsePatch(["@@", " ~target text", "~omitted context", "-~old text", "+~literal insert"].join("\n"));

    expect(parsed.hunks[0].ops).toMatchObject([
      { kind: "context", content: "target text", textSelector: "exact", smart: true },
      { kind: "context", content: "omitted context", textSelector: "exact", smart: true },
      { kind: "delete", content: "old text", textSelector: "exact", smart: true },
      { kind: "insert", content: "~literal insert" }
    ]);
  });

  it("rejects empty smart locators", () => {
    expect(() => parsePatch("@@\n ~")).toThrow("Line 2: Malformed context smart locator. Expected non-empty text after ~.");
    expect(() => parsePatch("@@\n~")).toThrow("Line 2: Malformed context smart locator. Expected non-empty text after ~.");
    expect(() => parsePatch("@@\n-~")).toThrow("Line 2: Malformed delete smart locator. Expected non-empty text after ~.");
  });

});
