import { describe, expect, it } from "vitest";
import {
  COLLAPSED_ERROR_INPUT_MAX_LINES,
  COLLAPSED_RESULT_DIFF_MAX_LINES,
  COLLAPSED_STREAMING_INPUT_MAX_LINES,
  EXPANDED_RESULT_DIFF_MAX_LINES,
  buildPatchCallRenderText,
  buildPatchResultRenderText,
  formatPatchResultDiff,
  getPatchCharEfficiency,
  getPatchSelectorEfficiency,
  getPatchMatcherStats,
  getPatchDiffStats,
  getPatchResultDiff,
  getPatchResultText,
  type PatchRenderTheme
} from "../src/tools/patch-render.js";

const theme: PatchRenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`
};

const makeDiff = (lineCount: number) => Array.from({ length: lineCount }, (_, index) => ` line-${index}`).join("\n");

describe("patch renderer helpers", () => {
  it("renders streaming patch input while args are incomplete, showing latest lines", () => {
    const patch = Array.from({ length: COLLAPSED_STREAMING_INPUT_MAX_LINES + 2 }, (_, index) => `line-${index + 1}`).join("\n");

    const rendered = buildPatchCallRenderText({
      input: { patch },
      expanded: false,
      argsComplete: false,
      theme
    });

    expect(rendered).toContain("<toolTitle>patch</toolTitle>");
    expect(rendered).toContain(`Agent input streaming (patch, last ${COLLAPSED_STREAMING_INPUT_MAX_LINES}/${COLLAPSED_STREAMING_INPUT_MAX_LINES + 2} lines):`);
    expect(rendered).toContain("... 2 earlier input lines omitted; Ctrl+O to expand");
    expect(rendered).toContain("<dim> 3 │ </dim><toolDiffContext>line-3</toolDiffContext>");
    expect(rendered).toContain("<dim>18 │ </dim><toolDiffContext>line-18</toolDiffContext>");
    expect(rendered).not.toContain("<dim> 1 │ </dim>");
    expect(rendered).not.toContain("<dim> 2 │ </dim>");
  });

  it("hides streaming input once args are complete so result rendering can take over", () => {
    const rendered = buildPatchCallRenderText({
      input: { patch: "*** Begin Patch\n*** End Patch", dry_run: true },
      expanded: false,
      argsComplete: true,
      theme
    });

    expect(rendered).toBe("<toolTitle>patch</toolTitle> <muted>dry-run</muted>");
    expect(rendered).not.toContain("Agent input streaming");
    expect(rendered).not.toContain("*** Begin Patch");
  });
  it("extracts model-visible text and details diff without changing either payload", () => {
    const result = { content: [{ type: "text", text: "compact status" }] };
    const details = { diff: "--- a/file\n+++ b/file\n-old\n+new" };

    expect(getPatchResultText(result)).toBe("compact status");
    expect(getPatchResultDiff(details)).toBe(details.diff);
    expect(getPatchResultDiff({ diff: "" })).toBeUndefined();
  });

  it("counts added and removed content lines without counting diff headers", () => {
    const diff = ["--- a/file", "+++ b/file", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");

    expect(getPatchDiffStats(diff)).toEqual({ additions: 1, removals: 1, totalLines: 5 });
  });

  it("counts matcher selector kinds from hunk audit match patterns", () => {
    const details = {
      files: [
        {
          audit: {
            hunkAudits: [
              {
                matchPattern: [
                  " :exact context",
                  "-:exact delete",
                  " ^prefix",
                  "-*contains",
                  " $suffix",
                  "-#abc",
                  " ?{\"prefix\":\"a\"}",
                  " ...",
                  "-..."
                ]
              }
            ]
          }
        }
      ]
    };

    expect(getPatchMatcherStats(details)).toEqual({
      exact: 2,
      prefix: 1,
      contains: 1,
      suffix: 1,
      subsequence: 0,
      fuzzy: 0,
      hash: 1,
      combined: 1,
      range: 2,
      unifiedDiff: 0,
      total: 9
    });
  });

  it("counts and renders unified-diff matchers separately", () => {
    const details = {
      files: [
        {
          audit: {
            hunkAudits: [
              { matcherKinds: ["unifiedDiff", "unifiedDiff"], matchPattern: [" :^literal", "-:#abc"] },
              { matcherKinds: ["prefix", "subsequence", "fuzzy"], matchPattern: [" ^prefix", " ~alpha beta", " ~profilePolciy"] }
            ]
          }
        }
      ]
    };

    expect(getPatchMatcherStats(details)).toMatchObject({ exact: 0, prefix: 1, subsequence: 1, fuzzy: 1, unifiedDiff: 2, total: 5 });

    const rendered = buildPatchResultRenderText({
      details: { ...details, diff: "--- a/file\n+++ b/file\n-old\n+new" },
      expanded: false,
      isPartial: false,
      isError: false,
      theme
    });
    expect(rendered).toContain("<muted>Matchers: prefix 1 / subsequence 1 / fuzzy 1 / unified-diff 2</muted>");
  });

  it("reads and renders patch char efficiency from result details", () => {
    const details = {
      charEfficiency: { patchChars: 5, baselineChars: 9 },
      selectorEfficiency: { patchChars: 7, baselineChars: 10 },
      diff: "--- a/file\n+++ b/file\n-old text\n+new"
    };

    expect(getPatchCharEfficiency(details)).toEqual({ patchChars: 5, baselineChars: 9 });
    expect(getPatchSelectorEfficiency(details)).toEqual({ patchChars: 7, baselineChars: 10 });

    const rendered = buildPatchResultRenderText({
      details,
      expanded: false,
      isPartial: false,
      isError: false,
      theme
    });

    expect(rendered).toContain("<muted>Patch efficiency: 5/9 chars vs baseline (55.6%, saved 44.4%)</muted>");
    expect(rendered).toContain("<muted>Selector cost: 70.0%</muted>");
  });

  it("renders selector cost metric at or below half of baseline", () => {
    const rendered = buildPatchResultRenderText({
      details: {
        selectorEfficiency: { patchChars: 5, baselineChars: 10 },
        diff: "--- a/file\n+++ b/file\n-old text\n+new"
      },
      expanded: false,
      isPartial: false,
      isError: false,
      theme
    });

    expect(rendered).toContain("<muted>Selector cost: 50.0%</muted>");
  });

  it("renders collapsed diff with compact limit, color, omission count, and Ctrl+O hint", () => {
    const diff = makeDiff(COLLAPSED_RESULT_DIFF_MAX_LINES + 2);
    const rendered = formatPatchResultDiff(diff, false, theme);

    expect(rendered.shownLineCount).toBe(COLLAPSED_RESULT_DIFF_MAX_LINES);
    expect(rendered.omittedLineCount).toBe(2);
    expect(rendered.text).toContain("<toolDiffContext> line-0</toolDiffContext>");
    expect(rendered.text).toContain("... 2 more diff lines omitted; Ctrl+O to expand");
    expect(rendered.text).not.toContain("line-17");
  });

  it("renders expanded diff with substantially larger limit and no expand hint", () => {
    const diff = makeDiff(EXPANDED_RESULT_DIFF_MAX_LINES + 1);
    const rendered = formatPatchResultDiff(diff, true, theme);

    expect(rendered.shownLineCount).toBe(EXPANDED_RESULT_DIFF_MAX_LINES);
    expect(rendered.omittedLineCount).toBe(1);
    expect(rendered.text).toContain("line-199");
    expect(rendered.text).toContain("... 1 more diff lines omitted");
    expect(rendered.text).not.toContain("Ctrl+O");
    expect(rendered.text).not.toContain("line-200");
  });

  it("handles partial, error, and no-diff result states cleanly", () => {
    expect(
      buildPatchResultRenderText({ details: undefined, expanded: false, isPartial: true, isError: false, theme })
    ).toBe("<warning>Applying patch...</warning>");
    expect(
      buildPatchResultRenderText({
        resultText: "Error: stale\nmore",
        details: undefined,
        expanded: false,
        isPartial: false,
        isError: true,
        theme
      })
    ).toBe("<error>Error: stale</error>");
    expect(
      buildPatchResultRenderText({
        resultText: "*** Update File: file.txt\nApplied",
        details: {},
        expanded: false,
        isPartial: false,
        isError: false,
        theme
      })
    ).toBe("<success>*** Update File: file.txt</success>");
  });

  it("brings partial patch failure details before the input preview", () => {
    const rendered = buildPatchResultRenderText({
      resultText: [
        "[E_PARTIAL_PATCH] Patch stopped after 0 applied operations.",
        "Applied:",
        "(none)",
        "Failed:",
        "*** Update File: src/file.ts",
        "[E_STALE_HUNK] Could not find hunk match.",
        "Skipped:",
        "(none)",
        "Retry patch: /tmp/pi-select-patch-abc/retry.patch"
      ].join("\n"),
      details: undefined,
      expanded: false,
      isPartial: false,
      isError: true,
      errorInput: { patch: "*** Begin Patch\n*** Update File: src/file.ts\n@@\n-old\n+new\n*** End Patch" },
      theme
    });

    expect(rendered).toContain("Failed:\n*** Update File: src/file.ts\n[E_STALE_HUNK] Could not find hunk match.");
    expect(rendered).toContain("Retry patch: /tmp/pi-select-patch-abc/retry.patch");
    expect(rendered.indexOf("Failed:")).toBeLessThan(rendered.indexOf("Agent input preview"));
    expect(rendered).not.toContain("Applied:\n(none)");
    expect(rendered).not.toContain("Skipped:\n(none)");
  });



  it("renders retry patch copy failures in compact partial errors", () => {
    const rendered = buildPatchResultRenderText({
      resultText: [
        "[E_PARTIAL_PATCH] Patch stopped after 0 applied operations.",
        "Applied:",
        "(none)",
        "Failed:",
        "*** Update File: src/file.ts",
        "[E_STALE_HUNK] Could not find hunk match.",
        "Skipped:",
        "(none)",
        "Retry patch unavailable: copy failed"
      ].join("\n"),
      details: undefined,
      expanded: false,
      isPartial: false,
      isError: true,
      theme
    });

    expect(rendered).toContain("Retry patch unavailable: copy failed");
  });

  it("renders error with input preview centered on reported line", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      ...Array.from({ length: COLLAPSED_ERROR_INPUT_MAX_LINES - 2 }, (_, index) => `+extra-${index}`),
      "old raw context",
      "+new",
      "*** End Patch"
    ].join("\n");

    const rendered = buildPatchResultRenderText({
      resultText: "[E_INVALID_PATCH] Line 18: Malformed patch operation. Use context, delete, insert, or selector row.",
      details: undefined,
      expanded: false,
      isPartial: false,
      isError: true,
      errorInput: { patch },
      theme
    });

    expect(rendered).toContain("<error>[E_INVALID_PATCH] Line 18: Malformed patch operation. Use context, delete, insert, or selector row.</error>");
    expect(rendered).toContain("Agent input around line 18 (patch, lines 14-20 of 20):");
    expect(rendered).toContain("... 13 earlier input lines omitted");
    expect(rendered).toContain("<error>18 │ </error><toolDiffContext>old raw context</toolDiffContext>");
    expect(rendered).toContain("<dim>19 │ </dim><toolDiffAdded>+new</toolDiffAdded>");
    expect(rendered).not.toContain("*** Begin Patch");
  });

  it("renders patch_file input path on errors when inline patch text is absent", () => {
    const rendered = buildPatchResultRenderText({
      resultText: "[E_FILE_TEXT] File not found: change.patch",
      details: undefined,
      expanded: false,
      isPartial: false,
      isError: true,
      errorInput: { patch_file: "change.patch" },
      theme
    });

    expect(rendered).toContain("<error>[E_FILE_TEXT] File not found: change.patch</error>");
    expect(rendered).toContain("<muted>Agent input:</muted>");
    expect(rendered).toContain("<dim>patch_file: </dim><toolDiffContext>change.patch</toolDiffContext>");
  });

  it("builds human render text from details.diff while keeping status content separate", () => {
    const diff = ["--- a/file", "+++ b/file", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
    const rendered = buildPatchResultRenderText({
      resultText: "*** Update File: file\nValidated",
      details: {
        dryRun: true,
        diff,
        files: [
          {
            audit: {
              hunkAudits: [{ matchPattern: ["-:old", " #abcd", " ?{\"contains\":[\"needle\"]}"] }]
            }
          }
        ]
      },
      expanded: false,
      isPartial: false,
      isError: false,
      theme
    });

    expect(rendered).toContain("Patch dry-run succeeded");
    expect(rendered).toContain("<toolDiffAdded>+1</toolDiffAdded>");
    expect(rendered).toContain("<toolDiffRemoved>-1</toolDiffRemoved>");
    expect(rendered).toContain("<toolDiffRemoved>-old</toolDiffRemoved>");
    expect(rendered).toContain("<toolDiffAdded>+new</toolDiffAdded>");
    expect(rendered).toContain("<muted>Matchers: exact 1 / hash 1 / combined 1</muted>");
    expect(rendered).not.toContain("*** Update File: file");
  });
});
