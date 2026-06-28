---
affects:
  - src/apply.ts
  - src/universal-patch-format.ts
---

# Codex-Style Hunk Boundaries

## Intent

Make multiple hunks inside one update section behave like Codex/unified-diff hunks: each hunk must match untouched original target lines, while explicit later file operations can build on earlier operations.

## Behavior

```pseudo
When applying an update section to text:
  represent each current line with content plus whether it is still an untouched original line

  for each hunk in order:
    find the hunk match only across current lines that are untouched original lines
    reject stale or ambiguous matches as before

    replace the matched span in current lines:
      inserted lines become non-original and unavailable to later hunks in the same update section
      deleted lines disappear
      context lines and context-range lines keep their content but become touched and unavailable to later hunks in the same update section
      lines outside the matched span remain available if still untouched originals

  serialize final current line content

When parsing a universal patch:
  accept multiple file operation sections for the same path
  keep operations in authored order
  let normal sequential operation execution decide whether each later section can see earlier section output
```
