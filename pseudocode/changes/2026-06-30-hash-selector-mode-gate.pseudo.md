---
affects:
  - src/patch-format.ts
  - src/universal-patch-format.ts
  - src/tools/selector-patch.ts
---

# Hash Selector Mode Gate

## Intent

Prevent default-mode patches from mistaking normal unified-diff lines that begin with `#` for hash selectors. Hash selector syntax is available only when the parser is explicitly told hash selectors are enabled; direct parser APIs keep hash selectors enabled by default for compatibility.

## Behavior

```pseudo
parse patch text with options:
  hash selectors enabled defaults to true when caller does not specify it

for each update hunk operation row:
  if row is insert:
    parse as literal insert content

  if hash selectors enabled:
    treat `#` as a selector marker
    ` #abc` and `-#abc` parse as hash context/delete selectors
    malformed hash selectors reject before any unified-diff fallback

  if hash selectors disabled:
    do not treat `#` as a selector marker
    ` #define X` parses as unified-diff exact context text `#define X`
    `-#old` parses as unified-diff exact delete text `#old`
    bare `#abc` remains invalid because bare unified-diff context rows are not accepted
    explicit exact selectors such as ` :#literal` and `:#literal` still match literal text starting with `#`

patch tool behavior:
  read current profile and per-call receipt/markerless options before parsing patch input
  parse update hunks with hash selectors enabled only when profile/receipt/markerless options enable them
  keep hash receipt output behavior unchanged
```
