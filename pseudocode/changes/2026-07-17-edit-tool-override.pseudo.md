---
affects:
  - src/index.ts
  - src/output-size.ts
  - src/tools/selector-patch.ts
  - src/tools/patch-render.ts
  - src/content-diff.ts
  - test/extension.test.ts
  - test/output-size.test.ts
  - test/selector-patch-tool.test.ts
  - test/session-integration.test.ts
  - README.md
  - docs/patch-format.md
---

# Register Selector Editing As `edit`

## Intent

Replace Pi's built-in `edit` interface with the selector-based editor at the same public tool name. Do not expose a public `patch` tool or compatibility alias.

## Behavior

```pseudo
when creating the selector editor tool:
  register it with public name `edit`
  keep its inline `patch` and `patch_file` fields as input-format data
  describe and guide agents to use the `edit` tool

when a session starts:
  register the selector editor under `edit`
  in hash profile, register the hash reader under `read`
  remove stale selector tool names and `read_hash` from active tools
  keep or add `edit` to active tools so the registered selector editor replaces the built-in interface
  never add or activate `patch`

when a successful edit result is returned, including dry runs and every receipt mode:
  set `details.patch` to a standard unified diff string for every planned file change
  preserve selector-specific details alongside `diff` and `patch`
  keep `details.diff` as the display-oriented transcript

when rendering the editor call or result:
  label human-facing tool output as `edit`
  use edit wording for progress, completion, failure, and output-size diagnostics
  retain patch wording only for input-format data, retry files, and algorithm details

when documenting Pi integration:
  describe the selector editor as `edit`
  retain `patch` terminology only for input format, files, receipts, and algorithm details

when testing the public extension seam:
  assert registration contains `edit` and not `patch`
  assert active tools contain `edit` and not `patch`
  assert the registered `edit` definition carries selector input and guidance
  assert every successful edit-result branch has a non-empty standard unified `details.patch`

when testing session integration:
  create a real Pi session with an allowlist containing only `edit` (plus mechanically required tools)
  assert active `edit` resolves to the selector edit schema and description
  assert no public `patch` tool is registered or active
```
