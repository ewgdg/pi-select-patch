---
affects:
  - src/apply.ts
  - src/tools/patch-render.ts
  - src/tools/selector-patch.ts
---

# Smart Char Subsequence

## Intent

Let smart selectors recover from compact sampled anchors where matching characters appear in order, but only after all stronger smart tiers fail.

## Behavior

```pseudo
smart selector line matching:
  if target line exactly equals query:
    match as exact
  else if query is empty:
    no match
  else if target line starts with query:
    match as prefix
  else if target line ends with query:
    match as suffix
  else if target line contains query:
    match as contains
  else if query tokens appear in target tokens in order:
    match as subsequence
  else if bounded fuzzy token-subsequence matches:
    match as fuzzy
  else if query is long enough to be useful and every query character appears in target line in order:
    match as charSubsequence
  else:
    no match

smart dominance ranking:
  charSubsequence is weaker than fuzzy
  exact, prefix/suffix, contains, token subsequence, and fuzzy keep their existing relative order

matcher reporting:
  audit rows may report charSubsequence
  render summary counts charSubsequence separately
  smart-profile prompt says char subsequence is last resolver tier
```