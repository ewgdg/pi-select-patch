import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  COLLAPSED_REPLACE_DIFF_MAX_LINES,
  COLLAPSED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE,
  COLLAPSED_REPLACE_PREVIEW_MAX_LINES,
  EXPANDED_REPLACE_DIFF_MAX_LINES,
  buildReplaceCallRenderText,
  buildReplaceResultRenderText,
  formatReplaceInputPreview,
  type ReplaceRenderTheme,
} from "../src/tools/replace-render.js";
import { createReplaceTool } from "../src/tools/replace.js";

const theme: ReplaceRenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

const makeDiff = (lineCount: number) => Array.from(
  { length: lineCount },
  (_, index) => index % 2 === 0 ? `+added-${index}` : `-removed-${index}`,
).join("\n");

describe("replace renderer", () => {
  it("renders the target header and labelled input while arguments stream", () => {
    const rendered = buildReplaceCallRenderText({
      input: {
        file_path: "src/file.ts",
        old_string: "old\ntext",
        new_string: "new\ntext",
      },
      argsComplete: false,
      expanded: false,
      theme,
    });

    expect(rendered).toContain("<toolTitle>replace</toolTitle> src/file.ts");
    expect(rendered).toContain("<dim>old_string:</dim>");
    expect(rendered).toContain("<toolDiffContext>old</toolDiffContext>");
    expect(rendered).toContain("<dim>new_string:</dim>");
    expect(rendered).toContain("<toolDiffContext>new</toolDiffContext>");
  });

  it("shows broad replacement intent only when enabled while arguments stream", () => {
    const enabled = buildReplaceCallRenderText({
      input: {
        file_path: "file.txt",
        old_string: "old",
        new_string: "",
        replace_all: true,
      },
      argsComplete: false,
      expanded: false,
      theme,
    });
    const disabled = buildReplaceCallRenderText({
      input: {
        file_path: "file.txt",
        old_string: "old",
        new_string: "new",
        replace_all: false,
      },
      argsComplete: false,
      expanded: false,
      theme,
    });

    expect(enabled).toContain("<dim>new_string:</dim> <muted>(empty)</muted>");
    expect(enabled).toContain("<warning>replace_all: true</warning>");
    expect(disabled).not.toContain("replace_all");
    expect(disabled).toContain("old_string:");
  });

  it("bounds multiline previews in collapsed and expanded views with explicit omission markers", () => {
    const value = Array.from(
      { length: COLLAPSED_REPLACE_PREVIEW_MAX_LINES + 3 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");

    const collapsed = formatReplaceInputPreview({ old_string: value, new_string: "new" }, false, theme);
    const expanded = formatReplaceInputPreview({ old_string: value, new_string: "new" }, true, theme);

    expect(collapsed).toContain("3 lines omitted");
    expect(collapsed).not.toContain(`line-${COLLAPSED_REPLACE_PREVIEW_MAX_LINES + 1}`);
    expect(expanded).toContain(`line-${COLLAPSED_REPLACE_PREVIEW_MAX_LINES + 3}`);
  });

  it("bounds an enormous single-line input by displayed characters", () => {
    const value = "x".repeat(COLLAPSED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE + 100);
    const rendered = formatReplaceInputPreview({ old_string: value, new_string: "new" }, false, theme);

    expect(rendered).toBeDefined();
    if (!rendered) throw new Error("Expected preview");
    expect(rendered).toContain("100 chars omitted");
    expect(rendered).not.toContain("x".repeat(COLLAPSED_REPLACE_PREVIEW_MAX_CHARS_PER_LINE + 1));
  });

  it("renders progress without discarding the call preview", () => {
    const call = buildReplaceCallRenderText({
      input: { file_path: "file.txt", old_string: "old", new_string: "new" },
      argsComplete: false,
      expanded: false,
      theme,
    });
    const result = buildReplaceResultRenderText({
      resultText: undefined,
      details: undefined,
      expanded: false,
      isPartial: true,
      isError: false,
      errorInput: undefined,
      theme,
    });

    expect(call).toContain("old_string:");
    expect(result).toBe("<warning>Replacing...</warning>");
  });

  it("renders the occurrence receipt and a bounded colorized diff without changing details", () => {
    const diff = makeDiff(COLLAPSED_REPLACE_DIFF_MAX_LINES + 2);
    const details = { diff, occurrenceCount: 4 };
    const rendered = buildReplaceResultRenderText({
      resultText: "Replaced 4 occurrences.",
      details,
      expanded: false,
      isPartial: false,
      isError: false,
      errorInput: undefined,
      theme,
    });

    expect(rendered).toContain("<success>Replaced 4 occurrences.</success>");
    expect(rendered).toContain("<toolDiffAdded>+added-0</toolDiffAdded>");
    expect(rendered).toContain("<toolDiffRemoved>-removed-1</toolDiffRemoved>");
    expect(rendered).toContain("2 more diff lines omitted");
    expect(details.diff).toBe(diff);
  });

  it("uses a larger independent diff budget when expanded", () => {
    const diff = makeDiff(EXPANDED_REPLACE_DIFF_MAX_LINES + 1);
    const rendered = buildReplaceResultRenderText({
      resultText: "Replaced 1 occurrence.",
      details: { diff, occurrenceCount: 1 },
      expanded: true,
      isPartial: false,
      isError: false,
      errorInput: undefined,
      theme,
    });

    expect(rendered).toContain(`removed-${EXPANDED_REPLACE_DIFF_MAX_LINES - 1}`);
    expect(rendered).toContain("1 more diff line omitted");
    expect(rendered).not.toContain("Ctrl+O");
  });

  it("renders only the complete first error line plus the bounded input preview", () => {
    const rendered = buildReplaceResultRenderText({
      resultText: "[E_REPLACE_AMBIGUOUS] Found 2 occurrences.\nsecret file contents\nRetry patch: /tmp/retry.patch",
      details: undefined,
      expanded: false,
      isPartial: false,
      isError: true,
      errorInput: {
        file_path: "file.txt",
        old_string: "old",
        new_string: "new",
      },
      theme,
    });

    expect(rendered).toContain("<error>[E_REPLACE_AMBIGUOUS] Found 2 occurrences.</error>");
    expect(rendered).toContain("old_string:");
    expect(rendered).not.toContain("secret file contents");
    expect(rendered).not.toContain("Retry patch");
  });

  it("keeps Pi's boxed background", () => {
    initTheme("dark", false);
    const replaceTool = createReplaceTool();
    const component = new ToolExecutionComponent(
      "replace",
      "tool-call",
      { file_path: "file.txt", old_string: "old", new_string: "new" },
      undefined,
      replaceTool as never,
      { requestRender() {} } as never,
      process.cwd(),
    );

    expect(component.render(120).join("\n")).toContain("\u001b[48;");
  });

  it("shows completed replacements as a patch without old and new argument previews", () => {
    initTheme("dark", false);
    const replaceTool = createReplaceTool();
    const component = new ToolExecutionComponent(
      "replace",
      "tool-call",
      {
        file_path: "file.txt",
        old_string: "OLD_ARGUMENT_PREVIEW",
        new_string: "NEW_ARGUMENT_PREVIEW",
      },
      undefined,
      replaceTool as never,
      { requestRender() {} } as never,
      process.cwd(),
    );

    component.setArgsComplete();
    component.updateResult({
      content: [{ type: "text", text: "Replaced 1 occurrence." }],
      details: { diff: "-OLD_ARGUMENT_PREVIEW\n+NEW_ARGUMENT_PREVIEW", occurrenceCount: 1 },
      isError: false,
    });

    const rendered = component.render(120).join("\n");
    expect(rendered).not.toContain("old_string:");
    expect(rendered).not.toContain("new_string:");
    expect(rendered).toContain("-OLD_ARGUMENT_PREVIEW");
    expect(rendered).toContain("+NEW_ARGUMENT_PREVIEW");
  });
});
