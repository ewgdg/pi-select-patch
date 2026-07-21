import { describe, expect, it } from "vitest";
import {
  AmbiguousHunkError,
  ConflictingHunksError,
  HunkCandidateLimitError,
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

  it("diagnoses a unique match outside a lower-bound line anchor without applying it", () => {
    expect(() => applyPatchToText("target\nx", anchoredPatch(2, "-:target"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found at or after line 2. Unique match exists outside line anchor at line 1."
    );
  });

  it("diagnoses a unique smart match outside a strict line anchor", () => {
    expect(() => applyPatchToText("target", anchoredPatch(2, "-~target"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found at or after line 2. Unique match exists outside line anchor at line 1."
    );
  });

  it("uses smart dominance for strict outside-anchor diagnostics", () => {
    expect(() => applyPatchToText("alpha\nalpha extra", anchoredPatch(3, "-~alpha"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found at or after line 3. Unique match exists outside line anchor at line 1."
    );
  });

  it("uses smart dominance for sparse strict outside-anchor diagnostics", () => {
    const text = "start\nalpha\nmid\nend\nstart\nalpha extra\nmid\nend extra";

    expect(() => applyPatchToText(text, anchoredPatch(9, " ~start", " ~alpha", " ...", " ~end"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found at or after line 9. Unique match exists outside line anchor at lines 1...4."
    );
  });

  it("diagnoses a unique multi-line match outside a ranged line anchor", () => {
    expect(() => applyPatchToText("before\nother\ntarget\nnext", anchoredRangePatch(1, 2, " :target", " :next"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found within lines 1...2. Unique match exists outside line anchor at lines 3...4."
    );
  });

  it("keeps strict outside-anchor diagnostics stale when the full source exceeds the candidate limit", () => {
    const text = Array.from({ length: 1_001 }, () => "x").join("\n");

    expect(() => applyPatchToText(text, anchoredPatch(1_002, "-:x"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found at or after line 1002."
    );
  });

  it("keeps stale detail when the whole-file diagnostic is ambiguous", () => {
    expect(() => applyPatchToText("target\nx\ntarget", anchoredPatch(4, "-:target"))).toThrow(
      "[E_STALE_HUNK] Line 2: Hunk not found at or after line 4."
    );
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
    expect(() => applyPatchToText("x\nx\nx", anchoredPatch(2, "-:x"))).toThrow("Ambiguity group hunks 1...1");
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
    expect(() => applyPatchToText("x\nx\nx", anchoredRangePatch(2, 3, "-:x"))).toThrow("Ambiguity group hunks 1...1");
  });

  it("rejects hunk anchor hints on pure insert hunks", () => {
    expect(() => applyPatchToText("", anchoredPatch(1, "+first"))).toThrow("anchor hint requires at least one context/deletion selector");
  });

  it("keeps contained tolerant matches ordinary", () => {
    const result = applyPatchToText("target\nold", anchoredRangePatch(1, 2, " :target", "-:old"), { anchorMode: "tolerant" });

    expect(result.text).toBe("target");
    expect(result.hunkAudits[0].anchorResolution).toBeUndefined();
  });

  it("recovers a unique finite-anchor overlap in tolerant mode", () => {
    const result = applyPatchToText("before\nstart\nold\nafter", anchoredRangePatch(3, 3, " :start", "-:old"), { anchorMode: "tolerant" });

    expect(result.text).toBe("before\nstart\nafter");
    expect(result.hunkAudits[0].anchorResolution).toEqual({
      affinity: "overlapping",
      authoredAnchor: { startLine: 3, endLine: 3 },
      resolvedMatch: { startLine: 2, endLine: 3 },
    });
  });

  it("recovers a unique outside match in tolerant mode", () => {
    const result = applyPatchToText("target", anchoredRangePatch(3, 3, "-:target"), { anchorMode: "tolerant" });

    expect(result.text).toBe("");
    expect(result.hunkAudits[0].anchorResolution).toEqual({
      affinity: "outside",
      authoredAnchor: { startLine: 3, endLine: 3 },
      resolvedMatch: { startLine: 1, endLine: 1 },
    });
  });

  it("classifies a lower-bound match crossing its start as overlapping", () => {
    const result = applyPatchToText("start\nold\nafter", anchoredPatch(2, " :start", "-:old"), { anchorMode: "tolerant" });

    expect(result.text).toBe("start\nafter");
    expect(result.hunkAudits[0].anchorResolution?.affinity).toBe("overlapping");
  });

  it("uses complete sparse spans for tolerant anchor affinity", () => {
    const result = applyPatchToText("start\nold\nmiddle\nend", anchoredRangePatch(3, 3, " :start", "-...", " :end"), { anchorMode: "tolerant" });

    expect(result.text).toBe("start\nend");
    expect(result.hunkAudits[0].anchorResolution).toEqual({
      affinity: "overlapping",
      authoredAnchor: { startLine: 3, endLine: 3 },
      resolvedMatch: { startLine: 1, endLine: 4 },
    });
  });

  it("stops at ambiguity in the active tolerant affinity class", () => {
    expect(() => applyPatchToText("x\nx\nx", anchoredRangePatch(2, 2, " :x", "-:x"), { anchorMode: "tolerant" })).toThrow(
      "Ambiguity group hunks 1...1",
    );
  });

  it("keeps a contained smart candidate ahead of a stronger outside candidate", () => {
    const result = applyPatchToText("alpha beta\nalpha beta extra", anchoredRangePatch(2, 2, "-~alpha beta"), { anchorMode: "tolerant" });

    expect(result.text).toBe("alpha beta");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["prefix"]);
    expect(result.hunkAudits[0].anchorResolution).toBeUndefined();
  });

  it("applies smart dominance within the active contained class", () => {
    const result = applyPatchToText("alpha beta extra\nalpha beta", anchoredRangePatch(1, 2, "-~alpha beta"), { anchorMode: "tolerant" });

    expect(result.text).toBe("alpha beta extra");
    expect(result.hunkAudits[0].matcherKinds).toEqual(["exact"]);
  });

  it("keeps original lines consumed by tolerated hunks unavailable to later hunks", () => {
    const patch = [
      anchoredRangePatch(3, 3, " :target", "+first"),
      anchoredRangePatch(3, 3, " :target", "+second"),
    ].join("\n");

    expect(() => applyPatchToText("target", patch, { anchorMode: "tolerant" })).toThrow(ConflictingHunksError);
  });

  it("does not let outside smart candidates consume an overlapping class candidate cap", () => {
    const outsidePairs = Array.from({ length: 1001 }, () => ["match candidate", "end"] as const).flat();
    const text = [...outsidePairs, "match candidate", "end"].join("\n");
    const anchorLine = outsidePairs.length + 2;
    const result = applyPatchToText(text, anchoredRangePatch(anchorLine, anchorLine, " ~match candidate", "-~end"), { anchorMode: "tolerant" });

    expect(result.text.split("\n").at(-1)).toBe("match candidate");
    expect(result.hunkAudits[0].anchorResolution?.affinity).toBe("overlapping");
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

  it("uses a later unique hunk as a boundary for an earlier ambiguous fixed hunk", () => {
    const multi = ["@@", "-:target", "+first", "+inserted", "@@", "-:boundary", "+done"].join("\n");

    const result = applyPatchToText("target\nboundary\ntarget", multi);

    expect(result.text).toBe("first\ninserted\ndone\ntarget");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([0, 1]);
    expect(result.hunkTranscripts.map((transcript) => transcript.matchStart)).toEqual([0, 1]);
  });

  it("uses an earlier unique hunk as a boundary for a later ambiguous fixed hunk", () => {
    const multi = ["@@", "-:boundary", "+done", "+inserted", "@@", "-:target", "+final"].join("\n");

    const result = applyPatchToText("target\nboundary\ntarget", multi);

    expect(result.text).toBe("target\ndone\ninserted\nfinal");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([1, 2]);
    expect(result.hunkTranscripts.map((transcript) => transcript.matchStart)).toEqual([1, 2]);
  });

  it("resolves a consecutive ambiguous fixed-hunk group by authored source order", () => {
    const multi = ["@@", "-:a", "-:x", "+first", "@@", "-:x", "-:b", "+second"].join("\n");

    const result = applyPatchToText("a\nx\nb\na\nx\nb", multi);

    expect(result.text).toBe("first\nb\na\nsecond");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([0, 4]);
  });

  it("uses authored order to resolve a consecutive smart-hunk group", () => {
    const multi = ["@@", "-~a", "-~x", "+first", "@@", "-~x", "-~b", "+second"].join("\n");

    const result = applyPatchToText("a\nx\nb\na\nx\nb", multi);

    expect(result.text).toBe("first\nb\na\nsecond");
    expect(result.hunkAudits.map((audit) => audit.orderAssisted)).toEqual([
      {
        groupStartHunk: 1,
        groupEndHunk: 2,
        selectedSpans: [
          { hunkIndex: 1, startLine: 1, endLine: 2 },
          { hunkIndex: 2, startLine: 5, endLine: 6 }
        ]
      },
      {
        groupStartHunk: 1,
        groupEndHunk: 2,
        selectedSpans: [
          { hunkIndex: 1, startLine: 1, endLine: 2 },
          { hunkIndex: 2, startLine: 5, endLine: 6 }
        ]
      }
    ]);
  });

  it("uses authored order to resolve a consecutive sparse-hunk group", () => {
    const multi = ["@@", "-:a", "-...", "-:b", "+first", "@@", "-:mid", "+second"].join("\n");

    const result = applyPatchToText("a\nmid\nb\na\nmid\nb", multi);

    expect(result.text).toBe("first\na\nsecond\nb");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([0, 4]);
    expect(result.hunkAudits[0].orderAssisted?.selectedSpans).toEqual([
      { hunkIndex: 1, startLine: 1, endLine: 3 },
      { hunkIndex: 2, startLine: 5, endLine: 5 }
    ]);
  });

  it("uses authored order within the active tolerant anchor affinity", () => {
    const multi = [
      "@@ @2...4", " :a", "-:x", "+first",
      "@@ @3...5", " :x", "-:b", "+second"
    ].join("\n");

    const result = applyPatchToText("a\nx\nb\na\nx\nb", multi, { anchorMode: "tolerant" });

    expect(result.text).toBe("a\nfirst\nb\na\nx\nsecond");
    expect(result.hunkAudits.map((audit) => audit.anchorResolution?.affinity)).toEqual(["overlapping", "overlapping"]);
  });

  it("keeps a stronger smart candidate ahead of authored source order", () => {
    const multi = ["@@", "-~alpha", "@@", "-:target"].join("\n");

    const result = applyPatchToText("alpha extra\ntarget\nalpha\ntarget", multi);

    expect(result.text).toBe("alpha extra\ntarget");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([2, 3]);
    expect(result.hunkAudits[0].matcherKinds).toEqual(["exact"]);
  });

  it("keeps a contained tolerant candidate ahead of source-order assistance", () => {
    const multi = ["@@ @3", "-:a", "@@", "-:b"].join("\n");

    const result = applyPatchToText("a\nb\na\nb", multi, { anchorMode: "tolerant" });

    expect(result.text).toBe("a\nb");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([2, 3]);
    expect(result.hunkAudits[0].anchorResolution).toBeUndefined();
  });

  it("keeps a group ambiguous when no conflict-free assignment is source ordered", () => {
    const multi = ["@@", "-:a", "-:x", "+first", "@@", "-:x", "-:b", "+second"].join("\n");

    expect(() => applyPatchToText("x\nb\na\nx\nb\na\nx", multi)).toThrow(AmbiguousHunkError);
  });

  it("reports conflicting hunks when an ambiguity group has no conflict-free assignment", () => {
    const multi = ["@@", "-:x", "-:x", "+first", "@@", "-:x", "-:x", "+second"].join("\n");

    expect(() => applyPatchToText("x\nx\nx", multi)).toThrow(ConflictingHunksError);
  });

  it("allows adjacent complete source spans", () => {
    const multi = [
      "@@", " :first", "-:second", "+replacement-second",
      "@@", " :third", "-:fourth", "+replacement-fourth"
    ].join("\n");

    expect(applyPatchToText("first\nsecond\nthird\nfourth", multi).text).toBe(
      "first\nreplacement-second\nthird\nreplacement-fourth"
    );
  });

  it("rejects a hunk nested in a preserved sparse source span", () => {
    const multi = [
      "@@", " :start", " ...", " :end", "+after-end",
      "@@", " :middle", "+after-middle"
    ].join("\n");

    expect(() => applyPatchToText("start\nmiddle\nend", multi)).toThrow(ConflictingHunksError);
  });

  it("rejects a hunk nested in a deleted sparse source span", () => {
    const multi = [
      "@@", "-:start", "-...", "-:end", "+replacement",
      "@@", " :middle", "+after-middle"
    ].join("\n");

    expect(() => applyPatchToText("start\nmiddle\nend", multi)).toThrow(ConflictingHunksError);
  });

  it.each([
    { kind: "preserved", sparseOps: [" :start", " ...", " :end", "+after-end"], anchor: "start" },
    { kind: "preserved", sparseOps: [" :start", " ...", " :end", "+after-end"], anchor: "end" },
    { kind: "deleted", sparseOps: ["-:start", "-...", "-:end", "+replacement"], anchor: "start" },
    { kind: "deleted", sparseOps: ["-:start", "-...", "-:end", "+replacement"], anchor: "end" }
  ])("rejects reuse of a $kind sparse range's $anchor anchor", ({ sparseOps, anchor }) => {
    const multi = ["@@", ...sparseOps, "@@", ` :${anchor}`, "+after-anchor"].join("\n");

    expect(() => applyPatchToText("start\nmiddle\nend", multi)).toThrow(ConflictingHunksError);
  });

  it("allows a hunk immediately after a sparse source span", () => {
    const multi = [
      "@@", " :start", " ...", " :end", "+after-end",
      "@@", " :after", "+after-after"
    ].join("\n");

    expect(applyPatchToText("start\nmiddle\nend\nafter", multi).text).toBe(
      "start\nmiddle\nend\nafter-end\nafter\nafter-after"
    );
  });

  it("filters an ambiguous hunk candidate that overlaps a fixed source span", () => {
    const multi = [
      "@@", " :fixed", " :x", "+after-fixed",
      "@@", "-:x", "-:b", "+replacement"
    ].join("\n");

    const result = applyPatchToText("fixed\nx\nb\nx\nb", multi);

    expect(result.text).toBe("fixed\nx\nafter-fixed\nb\nreplacement");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([0, 3]);
  });

  it("bounds ambiguity-group assignment search without retaining a Cartesian product", () => {
    const multi = Array.from({ length: 7 }, (_value, index) => ["@@", "-:x", `+replacement-${index}`].join("\n")).join("\n");

    expect(() => applyPatchToText(Array.from({ length: 14 }, () => "x").join("\n"), multi)).toThrow(AmbiguousHunkError);
  });

  it("resolves deep ambiguity groups iteratively without exhausting the call stack", () => {
    const hunkCount = 10_000;
    const text = Array.from({ length: hunkCount }, (_value, index) => [`item-${index}`, `item-${index}`]).flat().join("\n");
    const multi = Array.from({ length: hunkCount }, (_value, index) => [
      `@@ @${index * 2 + 1}...${index * 2 + 2}`,
      `-:item-${index}`
    ].join("\n")).join("\n");

    expect(() => applyPatchToText(text, multi)).toThrow(AmbiguousHunkError);
  });

  it("fails fixed candidate discovery explicitly at the shared hunk candidate limit", () => {
    const text = Array.from({ length: 1_001 }, () => "x").join("\n");
    const patchInput = { hunks: [{ ops: [{ kind: "delete" as const, content: "x" }] }] };

    expect(() => applyPatchToText(text, patchInput)).toThrow(HunkCandidateLimitError);
    expect(() => applyPatchToText(text, patch("-:x"))).toThrow("[E_HUNK_CANDIDATE_LIMIT] Line 2:");
    expect(() => applyPatchToText(text, patch("-~x"))).toThrow("[E_HUNK_CANDIDATE_LIMIT] Line 2:");
    expect(() => applyPatchToText(["a", ...Array.from({ length: 1_001 }, () => "b")].join("\n"), patch(" :a", " ...", " :b"))).toThrow("[E_HUNK_CANDIDATE_LIMIT] Line 2:");
    expect(() => applyPatchToText(text, anchoredRangePatch(1, 1_001, "-:x"), { anchorMode: "tolerant" })).toThrow("[E_HUNK_CANDIDATE_LIMIT] Line 2:");
    expect(patchInput).toEqual({ hunks: [{ ops: [{ kind: "delete", content: "x" }] }] });
    expect(applyPatchToText("x", patch("-:x")).text).toBe("");
  });

  it("reports cross-group source-span reuse as conflicting hunks before materialization", () => {
    const multi = [
      "@@", "-:a", "-:x", "+first",
      "@@", "-:x", "-:b", "+second",
      "@@", " :N", "+marker",
      "@@", "-~a", "-~x", "+third",
      "@@", "-~x", "-~b", "+fourth"
    ].join("\n");

    expect(() => applyPatchToText("a\nx\nb\na\nx\nb\nN", multi)).toThrow(ConflictingHunksError);
  });

  it("chooses the only conflict-free assignment even when it is out of authored source order", () => {
    const multi = ["@@", "-:a", "-:x", "+first", "@@", "-:x", "-:b", "+second"].join("\n");

    const result = applyPatchToText("a\nx\nb\na\nx", multi);

    expect(result.text).toBe("a\nsecond\nfirst");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([3, 1]);
  });

  it("resolves multiple independent ambiguous fixed-hunk groups in one section", () => {
    const multi = [
      "@@", "-:a", "-:x", "+first",
      "@@", "-:x", "-:b", "+second",
      "@@", " :separator", "+between",
      "@@", "-:c", "-:y", "+third",
      "@@", "-:y", "-:d", "+fourth"
    ].join("\n");

    const result = applyPatchToText("a\nx\nb\na\nx\nb\nseparator\nc\ny\nd\nc\ny\nd", multi);

    expect(result.text).toBe("first\nb\na\nsecond\nseparator\nbetween\nthird\nd\nc\nfourth");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([0, 4, 6, 7, 11]);
  });

  it("does not let an out-of-order unique hunk disable a local ambiguous group", () => {
    const multi = [
      "@@", " :marker", "+after-marker",
      "@@", "-:a", "-:x", "+first",
      "@@", "-:x", "-:b", "+second"
    ].join("\n");

    const result = applyPatchToText("a\nx\nb\na\nx\nb\nmarker", multi);

    expect(result.text).toBe("first\nb\na\nsecond\nmarker\nafter-marker");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([6, 0, 4]);
  });

  it("ignores mutually incompatible reverse-source boundaries around a locally ordered group", () => {
    const multi = [
      "@@", "-:P", "+p",
      "@@", "-:a", "-:x", "+first",
      "@@", "-:x", "-:b", "+second",
      "@@", "-:N", "+n"
    ].join("\n");

    const result = applyPatchToText("a\nx\nb\nN\nP\na\nx\nb", multi);

    expect(result.text).toBe("first\nb\nn\np\na\nsecond");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([4, 0, 6, 3]);
  });

  it("keeps a fixed-hunk group ambiguous when multiple complete assignments are source ordered", () => {
    const multi = ["@@", "-:a", "-:x", "+first", "@@", "-:x", "-:b", "+second"].join("\n");

    expect(() => applyPatchToText("a\nx\nb\na\nx\nb\na\nx\nb", multi)).toThrow(AmbiguousHunkError);
  });

  it("materializes uniquely resolved hunks in authored order despite reverse source order", () => {
    const multi = ["@@", " :second", "+after-second", "@@", " :first", "+after-first"].join("\n");

    const result = applyPatchToText("first\nsecond", multi);

    expect(result.text).toBe("first\nafter-first\nsecond\nafter-second");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([1, 0]);
    expect(result.hunkTranscripts.map((transcript) => transcript.matchStart)).toEqual([1, 0]);
  });

  it("materializes a prior later-line replacement before an earlier source hunk", () => {
    const multi = ["@@", "-:b", "+x", "@@", " :a", "+y"].join("\n");

    const result = applyPatchToText("a\nb", multi);

    expect(result.text).toBe("a\ny\nx");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([1, 0]);
    expect(result.hunkTranscripts.map((transcript) => transcript.matchStart)).toEqual([1, 0]);
  });

  it("preserves prior inserted output beside a later-materialized source span", () => {
    const multi = ["@@", "+x", " :b", "@@", " :a", "+y"].join("\n");

    const result = applyPatchToText("a\nb", multi);

    expect(result.text).toBe("a\ny\nx\nb");
    expect(result.hunkAudits.map((audit) => audit.matchStart)).toEqual([1, 0]);
    expect(result.hunkTranscripts.map((transcript) => transcript.matchStart)).toEqual([1, 0]);
  });

  it("does not let later hunks reuse original lines touched by earlier hunks", () => {
    const multi = ["@@", row(" ", "b"), row("+", "x"), "@@", row(" ", "b"), row("+", "y")].join("\n");

    expect(() => applyPatchToText("a\nb\nc", multi)).toThrow(ConflictingHunksError);
  });

  it("does not let later sparse hunks span lines touched by earlier hunks", () => {
    const multi = ["@@", row(" ", "b"), row("+", "x"), "@@", row(" ", "a"), " ...", row(" ", "d"), row("+", "y")].join("\n");

    expect(() => applyPatchToText("a\nb\nc\nd", multi)).toThrow(ConflictingHunksError);
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

  it("rejects multiple pure-insertion hunks for an empty file", () => {
    const multi = ["@@", "+first", "@@", "+second"].join("\n");

    expect(() => applyPatchToText("", multi)).toThrow(UnsupportedHunkError);
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
