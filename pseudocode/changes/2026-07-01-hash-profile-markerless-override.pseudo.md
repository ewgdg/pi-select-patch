---
affects:
  - src/tools/selector-patch.ts
  - README.md
  - docs/patch-format.md
---

# Hash profile markerless override

## Intent

Keep hash profile strict by default, but let an explicit per-call `markerless_selector` override row parsing.

## Behavior

```pseudo
when resolving patch execution options:
  start from configured profile defaults
  if markerless_selector is supplied:
    use it as the resolved markerless selector
  strict hash rows are enabled only when:
    configured profile is hash
    and markerless_selector was not supplied

with configured profile hash and no markerless_selector override:
  update hunk rows remain strict hash-only

with configured profile hash and markerless_selector override:
  parse markerless rows using the supplied markerless_selector
  keep hash selectors enabled because the configured profile is still hash
  receipt default remains hash unless receipt is separately overridden
```
