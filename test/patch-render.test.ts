import { describe, expect, it } from "vitest";
import {
  COLLAPSED_RESULT_DIFF_MAX_LINES,
  EXPANDED_RESULT_DIFF_MAX_LINES,
  buildPatchResultRenderText,
  formatPatchResultDiff,
  getPatchDiffStats,
  getPatchResultDiff,
  getPatchResultText,
  type PatchRenderTheme
} from "../src/tools/patch-render.js";

const theme: PatchRenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`
};

const makeDiff = (lineCount: number) => Array.from({ length: lineCount }, (_, index) => ` line-${index}`).join("\n");

describe("patch result renderer helpers", () => {
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

  it("builds human render text from details.diff while keeping status content separate", () => {
    const diff = ["--- a/file", "+++ b/file", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
    const rendered = buildPatchResultRenderText({
      resultText: "*** Update File: file\nValidated",
      details: { dryRun: true, diff },
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
    expect(rendered).not.toContain("*** Update File: file");
  });
});
