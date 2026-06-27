---
affects:
  - src/patch-format.ts
---

# Unified Diff Blank Line Operation

## Intent

Accept a physically blank hunk row as unified-diff muscle memory for an empty context line.

## Behavior

```pseudo
when parsing hunk operation rows:
  if row is empty string:
    parse it as a unified-diff context operation
    content is empty string
    selector is exact text
    mark operation as unifiedDiff

  otherwise keep existing operator rules:
    + starts insert content
    space or = starts context content
    - starts delete content
    explicit locator rows keep locator behavior
    malformed unsupported prefixes still reject
```