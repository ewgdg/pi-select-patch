---
affects:
  - src/tools/selector-patch.ts
  - src/universal-patch-format.ts
  - test/selector-patch-tool.test.ts
  - test/universal-patch-format.test.ts
---

# Tolerate trailing End Patch boundary

## Intent

Accept common agent output that uses section-only patch input but still appends a legacy closing boundary.

## Behavior

```pseudo
when parsing normalized universal patch input:
  if input starts with legacy opening boundary:
    require final legacy closing boundary
    parse only lines between the two boundaries
    reject any nested opening or closing boundary inside the body
  otherwise if input ends with one legacy closing boundary:
    treat that final closing boundary as tolerated trailing noise
    parse section-only file operations before it
    reject any other opening or closing boundary inside the parsed body
  otherwise:
    parse all lines as section-only file operations
    reject any opening or closing boundary inside the parsed body

retry patch tails copied from tolerated closing-only input:
  omit the tolerated trailing boundary so retry text is valid section-only patch input

tool prompt:
  tell agents to omit legacy Begin Patch and End Patch boundaries
  keep section-only format as the canonical authored input
  avoid explaining obvious section termination rules
```
