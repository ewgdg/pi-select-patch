---
affects:
  - src/tools/selector-patch.ts
  - test/selector-patch-tool.test.ts
  - test/output-size.test.ts
  - test/fs-text.test.ts
  - docs/patch-format.md
---

# Drop agent selector cost receipt

## Intent

Patch tool success receipts should stay focused on apply result. Selector cost remains structured metadata and TUI-only display, not agent-visible receipt text.

## Behavior

```pseudo
when patch tool builds successful agent-visible result text:
  if hash receipt requested:
    render hash receipt only
  else:
    render compact file status only

  if hash receipt overflows visible output limits:
    fall back to compact file status only

  do not append selector cost line to agent-visible result text

when patch tool builds details:
  continue attaching selectorEfficiency for consumers that need structured metrics

when Pi TUI renders patch result details:
  selector cost footer behavior stays unchanged
```
