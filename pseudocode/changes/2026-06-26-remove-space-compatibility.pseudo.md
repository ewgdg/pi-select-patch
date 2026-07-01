---
affects:
  - src/patch-format.ts
---

# Context Rows Use Space Operator

## Intent

Keep context rows explicit with a literal space operator. Do not support `=` as a context operator.

## Behavior

```pseudo
When parsing an update hunk row:
  if row begins with '+': parse inserted content after '+'
  if row begins with '-': parse delete selector after '-'
  if row begins with space:
    parse context selector after the leading space
  otherwise:
    reject patch as malformed operation

Exact context matching, including indented file lines, must use ` :` followed by the full raw line text.
```
