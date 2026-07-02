---
affects:
  - src/patch-format.ts
  - src/universal-patch-format.ts
  - src/tools/selector-patch.ts
  - README.md
  - docs/patch-format.md
---

# Markerless selector profile pseudocode

## Intent

Let config choose profile defaults for markerless context/delete rows, while per-call markerless_selector/receipt can override individual knobs and retry patches serialize explicit selectors.

## Behavior

```pseudo
Define markerless selector kinds: exact, smart, hash, prefix, contains.
Define patch profiles:
  classic -> markerless selector exact, status receipt
  smart   -> markerless selector smart, status receipt; default configured profile
  hash    -> markerless selector hash, hash receipt

When patch tool executes:
  read configured profile.
  start from configured profile defaults.
  if markerless_selector is supplied:
    override the configured profile's markerless selector.
  if receipt is supplied:
    override the configured profile/global receipt.
  enable explicit # selectors when configured profile is hash, receipt is hash, or markerless selector is hash.
  parse the universal patch with the resolved markerless selector and hash-selector flag.
  render status or hash receipt using the resolved receipt mode.

When parsing update hunk rows:
  insert rows beginning + always insert literal content.
  blank hunk rows still mean exact empty context.
  explicit selector markers keep current behavior and override defaults.
  leading-space context or -delete rows with no selector marker use the resolved markerless selector.
  bare rows with no operator and no selector marker are accepted as context only when the resolved markerless selector is not exact.
  exact default preserves current unified-diff exact behavior: context rows need leading space, delete rows use -text, and bare exact context remains invalid.
  hash default requires markerless text to be a valid 3- or 4-character hash; malformed markerless hashes fail.

When a parsed markerless operation is retried or serialized:
  write explicit selectors (:, ~, #, ^, *) instead of relying on the original markerless selector.
  therefore retry patches preserve semantics without needing the original profile/markerless_selector settings.
```
