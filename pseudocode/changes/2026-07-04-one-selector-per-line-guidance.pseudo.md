---
affects:
  - src/tools/selector-patch.ts
  - docs/patch-format.md
---

# One Selector Per Target Line Guidance

## Intent

Reduce stale hunk failures by making line consumption semantics explicit in patch prompts and docs.

## Behavior

```pseudo
when describing hunk matching to agents:
  state that each context/delete selector row consumes exactly one target line
  state that adjacent selector rows must match adjacent target lines unless a range row is used
  warn not to add separate locator/keyword rows for the same physical line
  tell agents to shorten the selector row itself instead
```
