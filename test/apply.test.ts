import { describe, expect, it } from "vitest";
import {
  AmbiguousHunkError,
  StaleHunkError,
  UnsupportedHunkError,
  applyPatchToText,
  hashLine
} from "../src/api.js";

const row = (prefix: "=" | "-" | "+", content: string, hashFn = hashLine) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashFn(content)}`;
const patch = (...lines: string[]) => ["@@", ...lines].join("\n");
const anchoredPatch = (line: number, ...lines: string[]) => [`@@ @${line}`, ...lines].join("\n");
const anchoredRangePatch = (startLine: number, endLine: number, ...lines: string[]) => [`@@ @${startLine}...${endLine}`, ...lines].join("\n");

describe("applyPatchToText", () => {
  it("replaces one line with unique surrounding context", () => {
    const result = applyPatchToText(
      "a\nold\nz\n",
      patch(row("=", "a"), row("-", "old"), row("+", "new"), row("=", "z"))
    );
    expect(result.text).toBe("a\nnew\nz\n");
    expect(result.renderedHashLines).toContain("new");
    expect(result.renderedReceipt).toBe(
      ["@@ result", `=${hashLine("a")}`, `+${hashLine("new")}`, `=${hashLine("z")}`].join("\n")
    );
    expect(result.renderedReceipt).not.toContain(hashLine("old"));
  });

  it("deletes and inserts using exact unique hash sequence", () => {
    const deleteResult = applyPatchToText("start\nremove\nend", patch(row("=", "start"), row("-", "remove"), row("=", "end")));
    expect(deleteResult.text).toBe("start\nend");
    expect(deleteResult.renderedReceipt).toBe(["@@ result", `=${hashLine("start")}`, `=${hashLine("end")}`].join("\n"));
    expect(deleteResult.hunkAudits[0].deletedHashes).toEqual([hashLine("remove")]);

    const insertResult = applyPatchToText("start\nend", patch(row("=", "start"), row("+", "middle"), row("=", "end")));
    expect(insertResult.text).toBe("start\nmiddle\nend");
  });

  it("matches 3-character hash locator prefixes", () => {
    const result = applyPatchToText("alpha target\nold value", patch(`=#${hashLine("alpha target").slice(0, 3)}`, `-#${hashLine("old value").slice(0, 3)}`, "+new value"));

    expect(result.text).toBe("alpha target\nnew value");
  });


  it("matches prefix text locators for context and delete operations", () => {
    const result = applyPatchToText(
      "function parsePatchOp(line: string): PatchOp {\n  return oldValue;\n}",
      patch(" ^function parsePatchOp", "-^  return old", "+  return newValue;", " :}")
    );

    expect(result.text).toBe("function parsePatchOp(line: string): PatchOp {\n  return newValue;\n}");
    expect(result.hunkAudits[0].matchPattern).toEqual([" ^function parsePatchOp", "-^  return old", " :}"]);
  });

  it("matches suffix text locators for context and delete operations", () => {
    const result = applyPatchToText(
      "const value = computeOld();\nreturn value;\nfinished();",
      patch(" $computeOld();", "-$value;", "+return nextValue;", " $finished();")
    );

    expect(result.text).toBe("const value = computeOld();\nreturn nextValue;\nfinished();");
    expect(result.hunkAudits[0].matchPattern).toEqual([" $computeOld();", "-$value;", " $finished();"]);
  });

  it("matches contains text locators for context and delete operations", () => {
    const result = applyPatchToText(
      "const value = computeOld();\nreturn value;\nfinished();",
      patch(" *computeOld", "-*turn val", "+return nextValue;", " *ished")
    );

    expect(result.text).toBe("const value = computeOld();\nreturn nextValue;\nfinished();");
    expect(result.hunkAudits[0].matchPattern).toEqual([" *computeOld", "-*turn val", " *ished"]);
  });

  it("matches combined text locators by all supplied predicates", () => {
    const result = applyPatchToText(
      "function parsePatchOp(line: string): PatchOp {\n  return oldValue;\n}\nfinished();",
      patch(
        ' ?{"prefix":"function ","contains":["parsePatchOp","PatchOp"],"suffix":" {"}',
        '-?{"prefix":"  return","contains":"old","suffix":";"}',
        "+  return newValue;",
        " :}",
        '=?{"contains":"finished"}'
      )
    );

    expect(result.text).toBe("function parsePatchOp(line: string): PatchOp {\n  return newValue;\n}\nfinished();");
    expect(result.hunkAudits[0].matchPattern).toEqual([
      ' ?{"prefix":"function ","contains":["parsePatchOp","PatchOp"],"suffix":" {"}',
      '-?{"prefix":"  return","contains":["old"],"suffix":";"}',
      " :}",
      ' ?{"contains":["finished"]}'
    ]);
  });

  it("throws stale and ambiguous for prefix, contains, and suffix locators", () => {
    expect(() => applyPatchToText("alpha one", patch("-^beta"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("one omega", patch("-*alpha"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("one omega", patch("-$alpha"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("prefix alpha suffix", patch('-?{"prefix":"prefix","contains":"missing","suffix":"suffix"}'))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("alpha one\nalpha two", patch("-^alpha"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("one omega\ntwo omega", patch("-*omega"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("one omega\ntwo omega", patch("-$omega"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("prefix alpha suffix\nprefix beta suffix", patch('-?{"prefix":"prefix","suffix":"suffix"}'))).toThrow(AmbiguousHunkError);
  });

  it("matches context/delete locators by hash-only and text-only forms", () => {
    const result = applyPatchToText(
      "a\nold\nz",
      patch(row("=", "a"), "-:old", "+new", "=:z")
    );

    expect(result.text).toBe("a\nnew\nz");
  });

  it("uses hunk anchor hints as lower-bound search starts for contiguous matches", () => {
    const result = applyPatchToText("target\nx\ntarget", anchoredPatch(3, "-:target"));

    expect(result.text).toBe("target\nx");
    expect(result.hunkAudits[0].matchStart).toBe(2);
  });

  it("does not search before hunk anchor hints", () => {
    expect(() => applyPatchToText("target\nx", anchoredPatch(2, "-:target"))).toThrow(/at or after line 2/);
  });

  it("uses hunk anchor hints as lower-bound search starts for sparse matches", () => {
    const result = applyPatchToText("start\nold\nend\npad\nstart\nold\nend", anchoredPatch(5, "=:start", "-...", "=:end"));

    expect(result.text).toBe("start\nold\nend\npad\nstart\nend");
    expect(result.hunkAudits[0].matchStart).toBe(4);
  });

  it("reports ambiguity at or after hunk anchor hints", () => {
    expect(() => applyPatchToText("x\nx\nx", anchoredPatch(2, "-:x"))).toThrow(/matched 2 spans at or after line 2/);
  });

  it("uses hunk anchor range hints for contiguous matches", () => {
    const result = applyPatchToText("target\nx\ntarget", anchoredRangePatch(2, 3, "-:target"));

    expect(result.text).toBe("target\nx");
    expect(result.hunkAudits[0].matchStart).toBe(2);
  });

  it("rejects contiguous matches ending after hunk anchor ranges", () => {
    expect(() => applyPatchToText("a\nb", anchoredRangePatch(1, 1, "=:a", "=:b"))).toThrow(/within lines 1\.\.\.1/);
  });

  it("uses hunk anchor range hints for sparse matches", () => {
    const result = applyPatchToText("start\nold\nend\npad\nstart\nold\nend", anchoredRangePatch(5, 7, "=:start", "-...", "=:end"));

    expect(result.text).toBe("start\nold\nend\npad\nstart\nend");
    expect(result.hunkAudits[0].matchStart).toBe(4);
  });

  it("rejects sparse matches ending after hunk anchor ranges", () => {
    expect(() => applyPatchToText("start\nold\nend", anchoredRangePatch(1, 2, "=:start", "-...", "=:end"))).toThrow(/within lines 1\.\.\.2/);
  });

  it("reports ambiguity within hunk anchor ranges", () => {
    expect(() => applyPatchToText("x\nx\nx", anchoredRangePatch(2, 3, "-:x"))).toThrow(/matched 2 spans within lines 2\.\.\.3/);
  });

  it("rejects hunk anchor hints on pure insert hunks", () => {
    expect(() => applyPatchToText("", anchoredPatch(1, "+first"))).toThrow("anchor hint requires at least one context/deletion locator");
  });

  it("rejects API match ops containing both hash and text", () => {
    expect(() => applyPatchToText("target\nold", { hunks: [{ ops: [{ kind: "context", hash: hashLine("target"), content: "target" }] }] })).toThrow("hash+text locators are not supported");
    expect(() => applyPatchToText("target\nold", { hunks: [{ ops: [{ kind: "context", hash: hashLine("target"), combinedSelector: { contains: ["target"] } }] }] })).toThrow("hash+text locators are not supported");
    expect(() => applyPatchToText("target\nold", { hunks: [{ ops: [{ kind: "context", content: "target", combinedSelector: { contains: ["target"] } }] }] })).toThrow("mixed text locators are not supported");
  });

  it("rejects malformed API combined selector locators", () => {
    expect(() => applyPatchToText("target", { hunks: [{ ops: [{ kind: "context", combinedSelector: {} }] }] })).toThrow("requires at least one");
    expect(() => applyPatchToText("target", { hunks: [{ ops: [{ kind: "context", combinedSelector: { contains: [] } }] }] })).toThrow("contains");
    expect(() => applyPatchToText("target", { hunks: [{ ops: [{ kind: "context", combinedSelector: { unknown: "target" } as never }] }] })).toThrow("unknown key");
  });

  it("matches blank-line and separator-leading text locators", () => {
    const blankResult = applyPatchToText("start\n\nend", patch("=:start", "-:", "=:end"));
    expect(blankResult.text).toBe("start\nend");

    const separatorResult = applyPatchToText("start\n│old\nend", patch("=:start", "-:│old", "+new", "=:end"));
    expect(separatorResult.text).toBe("start\nnew\nend");
  });

  it("uses text locators as sparse range anchors", () => {
    const result = applyPatchToText("start\nremove\nend", patch("=:start", "-...", "=:end"));

    expect(result.text).toBe("start\nend");
  });

  it("preserves sparse context ranges with ...", () => {
    const result = applyPatchToText("start\nkeep one\nkeep two\nend", patch(row("=", "start"), "=...", row("=", "end")));

    expect(result.text).toBe("start\nkeep one\nkeep two\nend");
    expect(result.renderedReceipt).toBe(["@@ result", `=${hashLine("start")}`, `=${hashLine("end")}`].join("\n"));
    expect(result.hunkTranscripts[0].lines).toContainEqual({ kind: "contextRange", content: "... 2 skipped context lines" });
  });

  it("uses sparse context ranges with insertions", () => {
    const result = applyPatchToText("start\nkeep\nend", patch(row("=", "start"), "=...", row("+", "inserted"), row("=", "end")));

    expect(result.text).toBe("start\nkeep\ninserted\nend");
  });

  it("deletes sparse ranges between context operations with -...", () => {
    const result = applyPatchToText("start\nremove one\nremove two\nend", patch(row("=", "start"), "-...", row("=", "end")));

    expect(result.text).toBe("start\nend");
    expect(result.renderedReceipt).toBe(["@@ result", `=${hashLine("start")}`, `=${hashLine("end")}`].join("\n"));
    expect(result.hunkAudits[0].deletedHashes).toEqual([hashLine("remove one"), hashLine("remove two")]);
  });

  it("replaces sparse ranges between context operations with -... and inserts", () => {
    const result = applyPatchToText("start\nold one\nold two\nend", patch(row("=", "start"), "-...", row("+", "new"), row("=", "end")));

    expect(result.text).toBe("start\nnew\nend");
    expect(result.renderedReceipt).toBe(["@@ result", `=${hashLine("start")}`, `+${hashLine("new")}`, `=${hashLine("end")}`].join("\n"));
  });

  it("applies multiple hunks sequentially", () => {
    const text = "a\nb\nc";
    const multi = [
      "@@",
      row("=", "a"),
      row("-", "b"),
      row("+", "bb"),
      "@@",
      row("=", "bb"),
      row("+", "between"),
      row("=", "c")
    ].join("\n");
    expect(applyPatchToText(text, multi).text).toBe("a\nbb\nbetween\nc");
  });

  it("allows duplicate lines elsewhere when full match sequence is unique", () => {
    const result = applyPatchToText("x\na\nb\nx", patch(row("=", "a"), row("-", "b")));
    expect(result.text).toBe("x\na\nx");
  });

  it("supports pure insertion only into an empty file", () => {
    const result = applyPatchToText("", patch(row("+", "first"), row("+", "second")));
    expect(result.text).toBe("first\nsecond");
    expect(() => applyPatchToText("already", patch(row("+", "extra")))).toThrow(UnsupportedHunkError);
  });

  it("deletes entire and single-line files", () => {
    const deleteOnly = applyPatchToText("only", patch(row("-", "only")));
    expect(deleteOnly.text).toBe("");
    expect(deleteOnly.receiptHashLineCount).toBe(0);
    expect(deleteOnly.renderedReceipt).toBe("@@ result");
    expect(applyPatchToText("a\nb", patch(row("-", "a"), row("-", "b"))).text).toBe("");
  });

  it("throws stale for absent or changed context/delete locators", () => {
    expect(() => applyPatchToText("a\nchanged\nz", patch(row("=", "a"), row("-", "old"), row("=", "z")))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("a\nold\nchanged", patch(row("=", "a"), row("-", "old"), row("=", "z")))).toThrow(StaleHunkError);
  });

  it("keeps apply transactional when later hunk fails", () => {
    const multi = [
      "@@",
      row("-", "a"),
      row("+", "aa"),
      "@@",
      row("-", "missing")
    ].join("\n");
    expect(() => applyPatchToText("a\nb", multi)).toThrow(StaleHunkError);
  });

  it("rejects stale, ambiguous, and unanchored ellipsis ranges", () => {
    expect(() => applyPatchToText("start\nold", patch(row("=", "start"), "=...", row("=", "end")))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("start\nend\nend", patch(row("=", "start"), "-...", row("=", "end")))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("start\nold", patch(row("=", "start"), "=..."))).toThrow(UnsupportedHunkError);
  });

  it("throws ambiguous when match hash sequence appears twice", () => {
    expect(() => applyPatchToText("x\nx", patch(row("-", "x")))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("a\nb\na\nb", patch(row("=", "a"), row("-", "b")))).toThrow(AmbiguousHunkError);
  });

  it("matches hash-only locators by hash and preserves target context content on hash collision", () => {
    const hashFn = (content: string) => (content === "target" || content === "patch" ? "AAAA" : hashLine(content));
    const result = applyPatchToText("target\nold", patch(row("=", "patch", hashFn), row("-", "old", hashFn), row("+", "new", hashFn)), { hashFn });
    expect(result.text).toBe("target\nnew");
  });

  it("can surface ambiguity from injected hash collisions", () => {
    const hashFn = (content: string) => (content.startsWith("same") ? "AAAA" : hashLine(content));
    expect(() => applyPatchToText("same-one\nsame-two", patch(row("-", "same-one", hashFn)), { hashFn })).toThrow(AmbiguousHunkError);
  });

  it("preserves CRLF, BOM, and terminal newline state", () => {
    const result = applyPatchToText("\uFEFFa\r\nold\r\n", patch(row("=", "a"), row("-", "old"), row("+", "new")));
    expect(result.text).toBe("\uFEFFa\r\nnew\r\n");
    expect(applyPatchToText("a\nold", patch(row("=", "a"), row("-", "old"), row("+", "new"))).text).toBe("a\nnew");
  });
});
