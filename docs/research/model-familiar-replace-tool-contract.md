# Model-familiar literal replace-tool contract

**Research date:** July 19, 2026  
**Question:** Which model-facing exact-text replacement contract is most likely to benefit from coding-model learned behavior?

## Answer

No complete contract dominates across model families. The strongest cross-product convergence is the operation shape, not the tool name:

```text
replace(
  file_path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean = false,
)
```

The most model-familiar descriptions are concise and behavioral:

- **Tool:** Replace exact literal text in one file. By default, `old_string` must occur exactly once; set `replace_all` to `true` to replace every occurrence.
- **`file_path`:** Path to the file to modify.
- **`old_string`:** Exact literal text to replace, including whitespace and newlines. Include enough unchanged surrounding text to make a single replacement unambiguous.
- **`new_string`:** Exact literal text to replace `old_string` with, including whitespace and newlines.
- **`replace_all`:** Replace every occurrence of `old_string`. Defaults to `false`.

This is an **inference**, assembled from the convergent parts of current products rather than copied from one product wholesale. Confidence is high for the three required snake-case parameters and unique-match default, moderate for `replace_all`, and lower for the tool name `replace` because names remain fragmented.

## Evidence

| Product | Current model-facing contract | Relevant behavior |
|---|---|---|
| Anthropic Claude Code 2.1.215 | `Edit(file_path, old_string, new_string, replace_all?)` | All fields are strings except optional boolean `replace_all`; its documented default is `false`. The tool performs exact string replacement and requires uniqueness unless replacing all. ([official tool reference](https://platform.claude.com/docs/en/agent-sdk/typescript#edit), [published first-party package metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-code/2.1.215)) |
| Google Gemini CLI | `replace(file_path, instruction, old_string, new_string, allow_multiple?)` | The three text/path fields are required strings; `instruction` is also required; `allow_multiple` is an optional boolean whose false default requires exactly one occurrence. ([commit-pinned schema](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/tools/definitions/model-family-sets/gemini-3.ts#L356-L394), [official tool documentation](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/docs/tools/file-system.md#L106-L122)) |
| GitHub Copilot in VS Code | `replace_string_in_file(filePath, oldString, newString)` | The model-facing name is `replace_string_in_file`; the schema requires three camel-case strings and replaces exactly one unique occurrence. Multiple edits use a separate `multi_replace_string_in_file` tool. ([model-facing names](https://github.com/microsoft/vscode/blob/5b3e1be7be9e1a2ccb2236fccebecb1b056d2d06/extensions/copilot/src/extension/tools/common/toolNames.ts#L36-L40), [schema and description](https://github.com/microsoft/vscode/blob/5b3e1be7be9e1a2ccb2236fccebecb1b056d2d06/extensions/copilot/package.json#L769-L840)) |
| OpenAI Codex | `apply_patch` freeform grammar | Codex does not expose a top-level exact-substitution JSON contract. Its current editing prior is a freeform patch tool, explicitly described as well-suited for GPT-5 models. ([commit-pinned tool definition](https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L5-L26)) |

Microsoft's current source is unusually direct evidence that learned editing priors are model-family-specific: it hard-codes `apply_patch` for GPT/OpenAI families and replace-string tools for Sonnet, while its broader capability routing enables `replace_string_in_file` for Anthropic, Gemini, xAI, and other families. ([learning preferences](https://github.com/microsoft/vscode/blob/5b3e1be7be9e1a2ccb2236fccebecb1b056d2d06/extensions/copilot/src/extension/tools/common/editToolLearningService.ts#L97-L108), [model capability routing](https://github.com/microsoft/vscode/blob/5b3e1be7be9e1a2ccb2236fccebecb1b056d2d06/extensions/copilot/src/platform/endpoint/common/chatModelCapabilities.ts#L245-L297))

## Inference

1. **Keep `file_path`, `old_string`, and `new_string`.** Anthropic and Google independently expose this exact snake-case core. Microsoft uses the same concepts with casing changes. This is the clearest shared learned pattern.
2. **Keep unique matching as the default.** Anthropic, Google, and Microsoft all make the single replacement fail when the target is absent or ambiguous.
3. **Use one optional boolean, defaulting to false.** `replace_all` has direct Anthropic precedent and states the action more plainly than Gemini's current `allow_multiple`. Microsoft's separate multi-replace tool reinforces that multiple matches should require explicit intent.
4. **Do not require `instruction` or `explanation`.** Gemini requires `instruction`, but Anthropic and Microsoft's public single-replace schemas do not. The literal before/after strings already specify the change.
5. **Use `replace`, with caveat.** It is the current Gemini CLI name and the shortest exact description of the operation. `Edit` has strong Claude-specific familiarity but denotes a broader operation; `replace_string_in_file` has broad Copilot exposure but is product-specific and verbose. There is no evidence that any one name is universal, so the schema and descriptions carry more compatibility weight than the name.
6. **Describe the contract, not a ritual.** Current tools consistently emphasize exact literal text, whitespace/newline fidelity, uniqueness, and sufficient surrounding context. Fixed prescriptions such as “three lines before and after” are not universal and should not be treated as part of the learned contract.

## Resolution

A single canonical contract is sufficient despite name and replace-all spelling differences. The compatibility target above preserves every strongly convergent behavior, follows the dominant snake-case core, and adds only the explicit multi-match switch already required by the parent specification.
