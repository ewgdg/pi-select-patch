---
affects:
  - src/tools/patch-render.ts
---

# Patch Matcher Diagnostics Footer

## Intent

Show which selector matcher kinds were used in a successful patch result so humans can diagnose whether the patch relied on exact text, prefix/suffix/contains, hashes, combined selectors, or ranges.

## Behavior

```pseudo
When rendering a successful patch result:
  render current success summary and diff preview
  inspect result details for per-file hunk audit matchPattern entries
  classify each match pattern token by selector marker:
    ':' -> exact
    '^' -> prefix
    '*' -> contains
    '$' -> suffix
    '#' -> hash
    '?' -> combined
    '...' -> range
  ignore inserted lines and non-audit data
  if at least one matcher exists:
    append muted footer: "Matchers: exact N / prefix N / ..."
    include only matcher kinds with nonzero counts
  otherwise:
    show no matcher footer
```
