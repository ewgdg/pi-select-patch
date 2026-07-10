import { describe, expect, it } from "vitest";
import {
  AmbiguousHunkError,
  StaleHunkError,
  UnsupportedHunkError,
  applyPatchToText,
  hashLine,
  parsePatch
} from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string, hashFn = hashLine) => prefix === "+" ? `${prefix}${content}` : `${prefix}#${hashFn(content)}`;
const patch = (...lines: string[]) => ["@@", ...lines].join("\n");
const anchoredPatch = (line: number, ...lines: string[]) => [`@@ @${line}`, ...lines].join("\n");
const anchoredRangePatch = (startLine: number, endLine: number, ...lines: string[]) => [`@@ @${startLine}...${endLine}`, ...lines].join("\n");

describe("applyPatchToText", () => {
  it("replaces one line with unique surrounding context", () => {
    const result = applyPatchToText(
      "a\nold\nz\n",
      patch(row(" ", "a"), row("-", "old"), row("+", "new"), row(" ", "z"))
    );
    expect(result.text).toBe("a\nnew\nz\n");
    expect(result.renderedHashLines).toContain("new");
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

  it("matches 3-character hash selector prefixes", () => {
    const result = applyPatchToText("alpha target\nold value", patch(` #${hashLine("alpha target").slice(0, 3)}`, `-#${hashLine("old value").slice(0, 3)}`, "+new value"));

    expect(result.text).toBe("alpha target\nnew value");
  });


  it("matches prefix text selectors for context and delete operations", () => {
    const result = applyPatchToText(
      "function parsePatchOp(line: string): PatchOp {\n  return oldValue;\n}",
      patch(" ^function parsePatchOp", "-^  return old", "+  return newValue;", " :}")
    );

    expect(result.text).toBe("function parsePatchOp(line: string): PatchOp {\n  return newValue;\n}");
    expect(result.hunkAudits[0].matchPattern).toEqual([" ^function parsePatchOp", "-^  return old", " :}"]);
  });

  it("applies literal replace rows to the previous context selector", () => {
    const result = applyPatchToText(
      "const timeoutMs = 5000;\nconst enabled = true;\n",
      patch("~timeoutMs", "/5000", "=3000")
    );

    expect(result.text).toBe("const timeoutMs = 3000;\nconst enabled = true;\n");
    expect(result.hunkTranscripts[0].lines).toEqual([
      { kind: "delete", content: "const timeoutMs = 5000;" },
      { kind: "insert", content: "const timeoutMs = 3000;" },
    ]);
    expect(result.renderedReceipt).toBe(["@@ result", `+${hashLine("const timeoutMs = 3000;")}`].join("\n"));
    expect(result.hunkAudits[0].matchPattern).toEqual([" ~timeoutMs"]);
    expect(result.hunkAudits[0].selectorPatchCharCount).toBe(" timeoutMs".length);
  });

  it("chains literal replace rows on the same selected line", () => {
    const result = applyPatchToText(
      "const url = \"/api/v1/users\";\n",
      patch("~url =", "//api/v1", "=/api/v2", "/users", "=accounts")
    );

    expect(result.text).toBe("const url = \"/api/v2/accounts\";\n");
  });

  it("applies empty literal replacement text", () => {
    const result = applyPatchToText(
      "const label = prefixValue;\n",
      patch("~label", "/prefix", "=")
    );

    expect(result.text).toBe("const label = Value;\n");
  });

  it("rejects stale, ambiguous, and unbound literal replace rows", () => {
    expect(() => applyPatchToText("const timeoutMs = 5000;", patch("~timeoutMs", "/6000", "=3000"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("repeat repeat", patch("~repeat", "/repeat", "=once"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("const value = aaa;", patch("~value", "/aa", "=b"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("old", patch("/old", "=new"))).toThrow("[E_INVALID_PATCH]");
    expect(() => applyPatchToText("old", patch("-old", "/old", "=new"))).toThrow("[E_INVALID_PATCH]");
  });

  it("matches omitted-space context selector rows without unified-diff matching", () => {
    const result = applyPatchToText(
      "function parsePatchOp(line: string): PatchOp {\n  return oldValue;\n}",
      patch("^function parsePatchOp", "-^  return old", "+  return newValue;", ":}")
    );

    expect(result.text).toBe("function parsePatchOp(line: string): PatchOp {\n  return newValue;\n}");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["prefix", "prefix", "exact"]);
    expect(result.hunkAudits[0].matchPattern).toEqual([" ^function parsePatchOp", "-^  return old", " :}"]);
  });

  it("matches suffix text selectors for context and delete operations", () => {
    const result = applyPatchToText(
      "const value = computeOld();\nreturn value;\nfinished();",
      patch(" $computeOld();", "-$value;", "+return nextValue;", " $finished();")
    );

    expect(result.text).toBe("const value = computeOld();\nreturn nextValue;\nfinished();");
    expect(result.hunkAudits[0].matchPattern).toEqual([" $computeOld();", "-$value;", " $finished();"]);
  });

  it("matches contains text selectors for context and delete operations", () => {
    const result = applyPatchToText(
      "const value = computeOld();\nreturn value;\nfinished();",
      patch(" *computeOld", "-*turn val", "+return nextValue;", " *ished")
    );

    expect(result.text).toBe("const value = computeOld();\nreturn nextValue;\nfinished();");
    expect(result.hunkAudits[0].matchPattern).toEqual([" *computeOld", "-*turn val", " *ished"]);
  });

  it("matches combined text selectors by all supplied predicates", () => {
    const result = applyPatchToText(
      "function parsePatchOp(line: string): PatchOp {\n  return oldValue;\n}\nfinished();",
      patch(
        ' ?{"prefix":"function ","contains":["parsePatchOp","PatchOp"],"suffix":" {"}',
        '-?{"prefix":"  return","contains":"old","suffix":";"}',
        "+  return newValue;",
        " :}",
        ' ?{"contains":"finished"}'
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

  it("throws stale and ambiguous for prefix, contains, and suffix selectors", () => {
    expect(() => applyPatchToText("alpha one", patch("-^beta"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("one omega", patch("-*alpha"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("one omega", patch("-$alpha"))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("prefix alpha suffix", patch('-?{"prefix":"prefix","contains":"missing","suffix":"suffix"}'))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("alpha one\nalpha two", patch("-^alpha"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("one omega\ntwo omega", patch("-*omega"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("one omega\ntwo omega", patch("-$omega"))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("prefix alpha suffix\nprefix beta suffix", patch('-?{"prefix":"prefix","suffix":"suffix"}'))).toThrow(AmbiguousHunkError);
  });

  it("matches context/delete selectors by hash-only and text-only forms", () => {
    const result = applyPatchToText(
      "a\nold\nz",
      patch(row(" ", "a"), "-:old", "+new", " :z")
    );

    expect(result.text).toBe("a\nnew\nz");
  });

  it("applies unified-diff rows when selector markers are missing", () => {
    const result = applyPatchToText("a\nold\nz", patch(" a", "-old", "+new", " z"));

    expect(result.text).toBe("a\nnew\nz");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["unifiedDiff", "unifiedDiff", "unifiedDiff"]);
    expect(result.hunkAudits[0].matchPattern).toEqual([" :a", "-:old", " :z"]);
  });

  it("applies blank unified-diff rows as empty context lines", () => {
    const result = applyPatchToText("a\n\nold\nz", patch(" a", "", "-old", "+new", " z"));

    expect(result.text).toBe("a\n\nnew\nz");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["unifiedDiff", "unifiedDiff", "unifiedDiff", "unifiedDiff"]);
    expect(result.hunkAudits[0].matchPattern).toEqual([" :a", " :", "-:old", " :z"]);
    expect(result.hunkAudits[0].baselineCharCount).toBe(12);
    expect(result.hunkAudits[0].patchLineCount).toBe(5);
    expect(result.hunkAudits[0].baselineLineCount).toBe(5);
  });

  it("does not retry with unified exact matching when selector matching finds no span", () => {
    expect(() => applyPatchToText("^literal\n#abc", patch(" ^literal", "-#abc", "+done"))).toThrow(StaleHunkError);
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
    const result = applyPatchToText("start\nold\nend\npad\nstart\nold\nend", anchoredPatch(5, " :start", "-...", " :end"));

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
    expect(() => applyPatchToText("a\nb", anchoredRangePatch(1, 1, " :a", " :b"))).toThrow(/within lines 1\.\.\.1/);
  });

  it("uses hunk anchor range hints for sparse matches", () => {
    const result = applyPatchToText("start\nold\nend\npad\nstart\nold\nend", anchoredRangePatch(5, 7, " :start", "-...", " :end"));

    expect(result.text).toBe("start\nold\nend\npad\nstart\nend");
    expect(result.hunkAudits[0].matchStart).toBe(4);
  });

  it("rejects sparse matches ending after hunk anchor ranges", () => {
    expect(() => applyPatchToText("start\nold\nend", anchoredRangePatch(1, 2, " :start", "-...", " :end"))).toThrow(/within lines 1\.\.\.2/);
  });

  it("reports ambiguity within hunk anchor ranges", () => {
    expect(() => applyPatchToText("x\nx\nx", anchoredRangePatch(2, 3, "-:x"))).toThrow(/matched 2 spans within lines 2\.\.\.3/);
  });

  it("rejects hunk anchor hints on pure insert hunks", () => {
    expect(() => applyPatchToText("", anchoredPatch(1, "+first"))).toThrow("anchor hint requires at least one context/deletion selector");
  });

  it("rejects API match ops containing both hash and text", () => {
    expect(() => applyPatchToText("target\nold", { hunks: [{ ops: [{ kind: "context", hash: hashLine("target"), content: "target" }] }] })).toThrow("hash+text selectors are not supported");
    expect(() => applyPatchToText("target\nold", { hunks: [{ ops: [{ kind: "context", hash: hashLine("target"), combinedSelector: { contains: ["target"] } }] }] })).toThrow("hash+text selectors are not supported");
    expect(() => applyPatchToText("target\nold", { hunks: [{ ops: [{ kind: "context", content: "target", combinedSelector: { contains: ["target"] } }] }] })).toThrow("mixed text selectors are not supported");
  });

  it("rejects malformed API combined selector selectors", () => {
    expect(() => applyPatchToText("target", { hunks: [{ ops: [{ kind: "context", combinedSelector: {} }] }] })).toThrow("requires at least one");
    expect(() => applyPatchToText("target", { hunks: [{ ops: [{ kind: "context", combinedSelector: { contains: [] } }] }] })).toThrow("contains");
    expect(() => applyPatchToText("target", { hunks: [{ ops: [{ kind: "context", combinedSelector: { unknown: "target" } as never }] }] })).toThrow("unknown key");
  });

  it("matches blank-line and separator-leading text selectors", () => {
    const blankResult = applyPatchToText("start\n\nend", patch(" :start", "-:", " :end"));
    expect(blankResult.text).toBe("start\nend");

    const separatorResult = applyPatchToText("start\n│old\nend", patch(" :start", "-:│old", "+new", " :end"));
    expect(separatorResult.text).toBe("start\nnew\nend");
  });

  it("uses text selectors as sparse range anchors", () => {
    const result = applyPatchToText("start\nremove\nend", patch(" :start", "-...", " :end"));

    expect(result.text).toBe("start\nend");
  });

  it("preserves sparse context ranges with ...", () => {
    const result = applyPatchToText("start\nkeep one\nkeep two\nend", patch(row(" ", "start"), " ...", row(" ", "end")));

    expect(result.text).toBe("start\nkeep one\nkeep two\nend");
    expect(result.renderedReceipt).toBe(["@@ result", ` ${hashLine("start")}`, ` ${hashLine("end")}`].join("\n"));
    expect(result.hunkTranscripts[0].lines).toContainEqual({ kind: "contextRange", content: "... 2 skipped context lines" });
  });

  it("uses sparse context ranges with insertions", () => {
    const result = applyPatchToText("start\nkeep\nend", patch(row(" ", "start"), " ...", row("+", "inserted"), row(" ", "end")));

    expect(result.text).toBe("start\nkeep\ninserted\nend");
  });

  it("deletes sparse ranges between context operations with -...", () => {
    const result = applyPatchToText("start\nremove one\nremove two\nend", patch(row(" ", "start"), "-...", row(" ", "end")));

    expect(result.text).toBe("start\nend");
    expect(result.renderedReceipt).toBe(["@@ result", ` ${hashLine("start")}`, ` ${hashLine("end")}`].join("\n"));
    expect(result.hunkAudits[0].deletedHashes).toEqual([hashLine("remove one"), hashLine("remove two")]);
  });

  it("replaces sparse ranges between context operations with -... and inserts", () => {
    const result = applyPatchToText("start\nold one\nold two\nend", patch(row(" ", "start"), "-...", row("+", "new"), row(" ", "end")));

    expect(result.text).toBe("start\nnew\nend");
    expect(result.renderedReceipt).toBe(["@@ result", ` ${hashLine("start")}`, `+${hashLine("new")}`, ` ${hashLine("end")}`].join("\n"));
  });

  it("uses context and delete operations as unified sparse range anchors", () => {
    const deleteAnchorsResult = applyPatchToText("first\nmiddle\nlast", patch(row("-", "first"), "-...", row("-", "last")));
    expect(deleteAnchorsResult.text).toBe("");
    expect(deleteAnchorsResult.hunkAudits[0].deletedHashes).toEqual([hashLine("first"), hashLine("middle"), hashLine("last")]);

    const mixedAnchorsResult = applyPatchToText("first\nmiddle\nlast", patch(row("-", "first"), " ...", row(" ", "last")));
    expect(mixedAnchorsResult.text).toBe("middle\nlast");
  });

  it("does not let later hunks match lines inserted by earlier hunks", () => {
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
    expect(() => applyPatchToText(text, multi)).toThrow(StaleHunkError);
  });

  it("does not let later hunks reuse original lines touched by earlier hunks", () => {
    const multi = ["@@", row(" ", "b"), row("+", "x"), "@@", row(" ", "b"), row("+", "y")].join("\n");

    expect(() => applyPatchToText("a\nb\nc", multi)).toThrow(StaleHunkError);
  });

  it("does not let later sparse hunks span lines touched by earlier hunks", () => {
    const multi = ["@@", row(" ", "b"), row("+", "x"), "@@", row(" ", "a"), " ...", row(" ", "d"), row("+", "y")].join("\n");

    expect(() => applyPatchToText("a\nb\nc\nd", multi)).toThrow(StaleHunkError);
  });

  it("lets later hunks match untouched original lines after earlier hunks shift offsets", () => {
    const multi = ["@@", row(" ", "b"), row("+", "x"), "@@", row("+", "y"), row(" ", "c")].join("\n");

    expect(applyPatchToText("a\nb\nc", multi).text).toBe("a\nb\nx\ny\nc");
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

  it("throws stale for absent or changed context/delete selectors", () => {
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

  it("rejects stale, ambiguous, and unanchored ellipsis ranges", () => {
    expect(() => applyPatchToText("start\nold", patch(row(" ", "start"), " ...", row(" ", "end")))).toThrow(StaleHunkError);
    expect(() => applyPatchToText("start\nend\nend", patch(row(" ", "start"), "-...", row(" ", "end")))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("start\nold", patch(row(" ", "start"), " ..."))).toThrow(UnsupportedHunkError);
  });

  it("throws ambiguous when match hash sequence appears twice", () => {
    expect(() => applyPatchToText("x\nx", patch(row("-", "x")))).toThrow(AmbiguousHunkError);
    expect(() => applyPatchToText("a\nb\na\nb", patch(row(" ", "a"), row("-", "b")))).toThrow(AmbiguousHunkError);
  });

  it("matches hash-only selectors by hash and preserves target context content on hash collision", () => {
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

  it("resolves smart selectors by exact before broader tiers", () => {
    const result = applyPatchToText("target text\ntarget text plus", patch("-~target text", "+replacement"));

    expect(result.text).toBe("replacement\ntarget text plus");
    expect(result.hunkAudits[0].matchPattern).toEqual(["-~target text"]);
    expect(result.hunkAudits[0].matcherKinds).toEqual(["exact"]);
  });

  it("applies parsed smart-profile unified-diff-style selectors", () => {
    const parsed = parsePatch(["@@", " alpha exact", "-contains target", "+replacement"].join("\n"), undefined, 0, { profile: "smart" });
    const result = applyPatchToText("alpha exact\nprefix contains target suffix", parsed);

    expect(result.text).toBe("alpha exact\nreplacement");
    expect(result.hunkAudits[0].matchPattern).toEqual([" ~alpha exact", "-~contains target"]);
    expect(result.hunkAudits[0].matcherKinds).toEqual(["exact", "contains"]);
  });

  it("matches blank smart selectors exactly", () => {
    const parsed = parsePatch(["@@", " before", "-", " after"].join("\n"), undefined, 0, { profile: "smart" });
    const profileResult = applyPatchToText("before\n\nafter", parsed);
    const explicitResult = applyPatchToText("before\n\nafter", patch(" ~before", "-~", " ~after"));

    expect(profileResult.text).toBe("before\nafter");
    expect(profileResult.hunkAudits[0].matcherKinds).toEqual(["exact", "exact", "exact"]);
    expect(explicitResult.text).toBe("before\nafter");
    expect(explicitResult.hunkAudits[0].matcherKinds).toEqual(["exact", "exact", "exact"]);
  });

  it("resolves each smart row independently and audits per-row matcher kind", () => {
    const result = applyPatchToText("alpha exact\nprefix contains target suffix", patch(" ~alpha exact", "-~contains target", "+replacement"));

    expect(result.text).toBe("alpha exact\nreplacement");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["exact", "contains"]);
  });

  it("uses subsequence matching for selector whitespace drift", () => {
    const result = applyPatchToText("${profilePolicy}", patch("-~    ${profilePolicy}", "+replacement"));

    expect(result.text).toBe("replacement");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["subsequence"]);
  });

  it("throws ambiguous when smart candidates trade off stronger rows", () => {
    expect(() =>
      applyPatchToText(
        "first target\nxx second target yy\nfirst target plus\nsecond target",
        patch("-~first target", "-~second target")
      )
    ).toThrow(AmbiguousHunkError);
  });

  it("uses whole-hunk dominance to choose the unique smart candidate", () => {
    const result = applyPatchToText(
      "first target\nxx second target yy\nxx first target yy\nxx second target yy",
      patch("-~first target", "-~second target", "+replacement")
    );

    expect(result.text).toBe("replacement\nxx first target yy\nxx second target yy");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["exact", "contains"]);
  });

  it("tries smart prefix and suffix as one ambiguity tier", () => {
    expect(() => applyPatchToText("alpha target x\nx alpha target", patch("-~alpha target"))).toThrow(AmbiguousHunkError);

    const prefixResult = applyPatchToText("alpha target x", patch("-~alpha target"));
    expect(prefixResult.text).toBe("");
    expect(prefixResult.hunkAudits[0].matcherKinds).toEqual(["prefix"]);

    const suffixResult = applyPatchToText("x alpha target", patch("-~alpha target"));
    expect(suffixResult.text).toBe("");
    expect(suffixResult.hunkAudits[0].matcherKinds).toEqual(["suffix"]);
  });

  it("tries smart contains after prefix/suffix and reports hunk-level ambiguity", () => {
    const result = applyPatchToText("x remove value y", patch("-~remove value"));

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["contains"]);
    expect(() => applyPatchToText("x remove value y\nz remove value q", patch("-~remove value"))).toThrow(AmbiguousHunkError);
  });

  it("tries smart whitespace token subsequence last", () => {
    const result = applyPatchToText("alpha keep middle target", patch("-~alpha target"));

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["subsequence"]);
  });

  it("uses strict fuzzy token-subsequence matching before char subsequence", () => {
    const result = applyPatchToText("return profilePolicy;", patch("-~return profilePolciy;"));

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["fuzzy"]);
  });

  it("uses char subsequence matching as the last smart tier", () => {
    const result = applyPatchToText("alpha beta gamma", patch("-~al gm"));

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["charSubsequence"]);
  });

  it("uses character subsequence for a compact selector without spaces", () => {
    const result = applyPatchToText(
      "long_object_name.long_function_call(long_arg_name)",
      patch("-~longobj.longcall(arg)"),
    );

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["charSubsequence"]);
  });

  it("prefers fuzzy over final char subsequence matching", () => {
    const result = applyPatchToText("return profilePolicy;", patch("-~return profilePolic;"));

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["fuzzy"]);
  });

  it("prefers lower fuzzy edit cost when smart candidates only differ by typo distance", () => {
    const result = applyPatchToText("return profilePolicx;\nreturn profilePolicy;", patch("-~return profilePolciy;"));

    expect(result.text).toBe("return profilePolicx;");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["fuzzy"]);
  });

  it("rejects fuzzy matches for short tokens", () => {
    expect(() => applyPatchToText("a bet", patch("-~bot"))).toThrow(StaleHunkError);
  });

  it("allows all-fuzzy multi-token selectors when the match is unique", () => {
    const result = applyPatchToText("profilePolicy selectorConfig", patch("-~profilePolciy selectorConfg"));

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["fuzzy"]);
  });

  it("throws ambiguous when fuzzy smart candidates have the same edit cost", () => {
    expect(() => applyPatchToText("return profilePolicy;\nreturn profilePolciy?", patch("-~return profilePolciy;"))).toThrow(AmbiguousHunkError);
  });

  it("uses fixed selectors and sparse ranges with smart hunk matching", () => {
    const constrained = applyPatchToText("unique\ntarget one\nother\ntarget two", patch(" :unique", "-~target", "+replacement"));
    expect(constrained.text).toBe("unique\nreplacement\nother\ntarget two");
    expect(constrained.hunkAudits[0].matcherKinds).toEqual(["exact", "prefix"]);

    const sparse = applyPatchToText("start marker\nremove\nend marker", patch(" ~start", "-...", " ~end"));
    expect(sparse.text).toBe("start marker\nend marker");
    expect(sparse.hunkAudits[0].matcherKinds).toEqual(["prefix", "range", "prefix"]);
  });

  it("allows broad smart matching for short and punctuation queries", () => {
    const prefixResult = applyPatchToText("xx", patch("-~x"));
    const punctuationResult = applyPatchToText("--- x ---", patch("-~--- ---"));

    expect(prefixResult.text).toBe("");
    expect(prefixResult.hunkAudits[0].matcherKinds).toEqual(["prefix"]);
    expect(() => applyPatchToText("a b", patch("-~ab"))).toThrow(StaleHunkError);
    expect(punctuationResult.text).toBe("");
    expect(punctuationResult.hunkAudits[0].matcherKinds).toEqual(["subsequence"]);
    expect(() => applyPatchToText("alpha middle beta", patch("-~alpha beta"))).not.toThrow();
  });

  it("keeps smart insert rows as literal inserted content", () => {
    const result = applyPatchToText("anchor", patch(" ~anchor", "+~literal"));

    expect(result.text).toBe("anchor\n~literal");
    expect(result.hunkTranscripts[0].lines).toContainEqual({ kind: "insert", content: "~literal" });
  });

});
