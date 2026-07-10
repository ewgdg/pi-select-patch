---
affects:
  - src/config.ts
  - src/patch-format.ts
  - src/tools/selector-patch.ts
---

# Explicit profile rename

## Intent

Name the marker-based selector profile after its behavior instead of its history.

## Behavior

```pseudo
supported selector patch profiles are:
  smart
  explicit
  hash

default extension profile is smart

when configuration or environment selects "explicit":
  activate marker-based selectors and status receipts

when patch parser profile is omitted:
  preserve marker-based parsing behavior under profile name "explicit"

when generating tool descriptions and prompt policy for explicit profile:
  call it Explicit Profile
  describe its explicit selector markers
```
