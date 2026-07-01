---
affects:
  - src/dedent.ts
  - src/universal-patch-format.ts
  - src/tools/selector-patch.ts
  - test/universal-patch-format.test.ts
  - test/selector-patch-tool.test.ts
  - README.md
  - docs/patch-format.md
---

# Section-only patch input

## Intent

Make file operation sections the visible patch format, while preserving existing serialized retry patches and older input compatibility.

## Behavior

```pseudo
when parsing patch input:
  normalize indentation
  skip leading blank lines for format detection
  if first meaningful line is the legacy opening boundary:
    require matching closing boundary
    parse file operation sections between boundaries
    keep original input line numbers in errors
  otherwise:
    parse file operation sections from first meaningful line through end of input
    keep original input line numbers in errors

file operation parsing:
  require at least one Add File, Update File, or Delete File section
  parse Add File, Update File, and Delete File sections exactly as before
  reject non-section text where a file operation header is expected

tool prompt and docs:
  show section-only patch examples
  describe file operation sections and hunk rules only
  omit boundary terminology from user-facing docs

retry patch serialization:
  continue serializing reusable retry patches with existing canonical boundaries
```