---
affects:
  - src/apply.ts
---

# Out-of-Bound Match Diagnostic

## Intent

Explain a unique match outside an authored line anchor without weakening the anchor or applying that match.

## Behavior

```pseudo
when an anchored hunk has no resolved match inside its authored boundary:
  keep line anchor as hard constraint for application
  do not widen boundary or apply diagnostic result

  run same hunk resolver against whole current file:
    keep touched-line exclusions
    keep contiguous vs sparse matching
    keep smart matcher tiers, dominance, ambiguity, and candidate-cap rules
    remove only anchor start/end limits

  if diagnostic resolver returns exactly one resolved match
      and resolved match lies outside authored boundary:
    throw existing StaleHunkError with existing first sentence unchanged
    append:
      for one-line match: "Unique match exists outside line anchor at line N."
      for multi-line match: "Unique match exists outside line anchor at lines N...M."
    report N..M as 1-based inclusive target lines

  if diagnostic resolver returns no match:
    throw original bounded StaleHunkError unchanged

  if diagnostic resolver throws expected AmbiguousHunkError:
    suppress diagnostic error
    throw original bounded StaleHunkError unchanged

  if diagnostic resolver throws any other error:
    propagate it
```
