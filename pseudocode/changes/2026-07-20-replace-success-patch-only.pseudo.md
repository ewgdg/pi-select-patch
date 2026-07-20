---
affects:
  - src/tools/replace-render.ts
  - src/tools/replace.ts
---

# Replace success shows the patch, not completed arguments

## Intent

Keep `old_string` and `new_string` visible only while the agent is streaming the Replace tool call; once arguments are complete, the final tool display should focus on the replacement result and patch.

## Behavior

```pseudo
render Replace call:
  always show the Replace title and target path when available

  if tool-call arguments are still streaming:
    show bounded old_string and new_string previews as they arrive
    show replace_all when enabled

  otherwise:
    do not show old_string, new_string, or replace_all

render successful Replace result:
  keep the existing success receipt and bounded colorized patch view
```
