---
affects:
  - src/errors.ts
  - src/patch-format.ts
  - src/universal-patch-format.ts
  - src/apply.ts
  - src/read-format.ts
  - src/tools/selector-patch.ts
---

# Concise Hunk Error Messages

## Intent

Make failed patch hunk diagnostics point to the patch line first and stop echoing long selector text.

## Behavior

```pseudo
When parsing update hunks:
  remember source input line for each hunk header
  remember source input line for each operation row

When rejecting malformed patch syntax with a known source line:
  format the error with the source line number first
  describe the expected row type or selector type briefly
  do not echo the full offending row or long selector content
  avoid quotation-wrapped user input in error details

When a hunk has no matches:
  reject with stale hunk error located at first matching row, or hunk header if no matching row exists
  message says: Hunk <number> not found<anchor scope>.
  do not echo the full match pattern or quote selector text

When a hunk matches multiple spans:
  reject with ambiguous hunk error located at first matching row, or hunk header if no matching row exists
  message says: Hunk <number> matched <count> spans<anchor scope>.
  do not echo the full match pattern or quote selector text

When a hunk is unsupported or has conflicting selectors:
  reject at the hunk header or offending operation row
  keep message short and state the violated rule
  do not echo selector text or quote the row

When patch tool reports a sequential failure:
  show failed operation header
  show compact error message with line number provided by patch errors
  keep retry patch path
```