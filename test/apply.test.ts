import { describe, expect, it } from "vitest";
import {
  AmbiguousHunkError,
  StaleHunkError,
  UnsupportedHunkError,
  applyPatchToText,
  hashLine
} from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string, hashFn = hashLine) => prefix === "+" ? `${prefix}${content}` : `${prefix}${hashFn(content)}`;
const patch = (...lines: string[]) => ["@@", ...lines].join("\n");

describe("applyPatchToText", () => {
  it("replaces one line with unique surrounding context", () => {
    const result = applyPatchToText(
      "a\nold\nz\n",
      patch(row(" ", "a"), row("-", "old"), row("+", "new"), row(" ", "z"))
    );
    expect(result.text).toBe("a\nnew\nz\n");
    expect(result.renderedHashLines).toContain(`${hashLine("new")}│new`);
    expect(result.renderedReceipt).toBe(
      ["@@ result", ` ${hashLine("a")}`, `+${hashLine("new")}`, ` ${hashLine("z")}`].join("\n")
    );
    expect(result.renderedReceipt).not.toContain(hashLine("old"));
  });

  it("deletes and inserts using exact unique hash sequence", () => {
    const deleteResult = applyPatchToText("start\nremove\nend", patch(row(" ", "start"), row("-", "remove"), row(" ", "end")));
    expect(deleteResult.text).toBe("start\nend");
    expect(deleteResult.renderedReceipt).toBe(["@@ result", ` ${hashLine("start")}`, ` ${hashLine("end")}`].join("\n"));
    expect(deleteResult.hunkAudits[0].deletedHashes).toEqual([hashLine("remove")]);

    const insertResult = applyPatchToText("start\nend", patch(row(" ", "start"), row("+", "middle"), row(" ", "end")));
    expect(insertResult.text).toBe("start\nmiddle\nend");
  });

  it("applies multiple hunks sequentially", () => {
    const text = "a\nb\nc";
    const multi = [
      "@@",
      row(" ", "a"),
      row("-", "b"),
      row("+", "bb"),
      "@@",
      row(" ", "bb"),
      row("+", "between"),
      row(" ", "c")
    ].join("\n");
    expect(applyPatchToText(text, multi).text).toBe("a\nbb\nbetween\nc");
  });

  it("allows duplicate lines elsewhere when full match sequence is unique", () => {
    const result = applyPatchToText("x\na\nb\nx", patch(row(" ", "a"), row("-", "b")));
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

  it("throws stale for absent or changed context/deletion hashes", () => {
    expect(() => applyPatchToText("a\nchanged\nz", patch(row(" ", "a"), row("-", "old"), row(" ", "z")))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("a\nold\nchanged", patch(row(" ", "a"), row("-", "old"), row(" ", "z")))).toThrow(StaleHunkError);
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

  it("throws ambiguous when match hash sequence appears twice", () => {
    expect(() => applyPatchToText("x\nx", patch(row("-", "x")))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("a\nb\na\nb", patch(row(" ", "a"), row("-", "b")))).toThrow(AmbiguousHunkError);
  });

  it("uses only hashes for matching and preserves target context content on hash collision", () => {
    const hashFn = (content: string) => (content === "target" || content === "patch" ? "AAAA" : hashLine(content));
    const result = applyPatchToText("target\nold", patch(row(" ", "patch", hashFn), row("-", "old", hashFn), row("+", "new", hashFn)), { hashFn });
    expect(result.text).toBe("target\nnew");
  });

  it("can surface ambiguity from injected hash collisions", () => {
    const hashFn = (content: string) => (content.startsWith("same") ? "AAAA" : hashLine(content));
    expect(() => applyPatchToText("same-one\nsame-two", patch(row("-", "same-one", hashFn)), { hashFn })).toThrow(AmbiguousHunkError);
  });

  it("preserves CRLF, BOM, and terminal newline state", () => {
    const result = applyPatchToText("\uFEFFa\r\nold\r\n", patch(row(" ", "a"), row("-", "old"), row("+", "new")));
    expect(result.text).toBe("\uFEFFa\r\nnew\r\n");
    expect(applyPatchToText("a\nold", patch(row(" ", "a"), row("-", "old"), row("+", "new"))).text).toBe("a\nnew");
  });
});
