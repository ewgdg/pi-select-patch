---
affects:
  - src/patch-format.ts
  - src/apply.ts
  - src/tools/selector-patch.ts
  - src/index.ts
---

# Replace Row And Hide Edit

## Intent

Make tiny intra-line replacements first-class patch operations, then remove the built-in `edit` tool from active sessions so agents use `patch` for file edits.

## Behavior

```pseudo
when parsing hunk operation rows:
  accept replace rows that start with r
  parse the rest of the row as exactly two JSON strings: oldText and newText
  reject malformed JSON strings, trailing text, empty oldText, or old/new text containing line breaks
  create a replace operation with oldText, newText, input line, and authored character count

when validating a hunk:
  each replace row must follow a context selector row or another replace row already bound to that same context selector
  reject replace rows after delete, insert, range, or at the start of a hunk

when matching a hunk:
  replace rows do not consume target lines and do not anchor the hunk
  the previous context selector chooses the line that replace rows mutate

when applying a hunk:
  for a context selector followed by one or more replace rows:
    start with the selected target line content
    apply each replace row in order to that line
    for each replace row:
      reject stale if oldText appears zero times in the current line
      reject ambiguous if oldText appears more than once in the current line
      replace oldText with newText literally
    emit the final line as a changed line, not surviving context
    mark the final line unavailable for later hunk matching
    render transcript as deleting the original line and inserting the final line
    render hash receipt as inserted final-line hash only
  context selectors without replace rows keep current context behavior

when computing patch audit:
  replacement row authored characters count toward patch character efficiency
  replacement final inserted line counts toward unified-diff baseline once
  replacement rows do not count toward selector efficiency

when Pi session starts with this extension:
  remove built-in edit from active tools
  keep patch active
  in hash profile, keep hash read active

when building patch tool prompt guidance:
  tell agents that edit is hidden
  default to patch for source/docs/test changes
  use replace rows for tiny literal intra-line replacements
```
