---
affects:
  - src/tools/selector-patch.ts
---

# Short-selector-first prompt

## Intent

Make smart-profile agents begin with compact selectors instead of copying full target lines.

## Behavior

```pseudo
when exposing the smart-profile patch tool to an agent:
  keep the short tool snippet generic and non-duplicative
  place detailed selector strategy in the patch policy and examples

in patch policy guidance:
  on first attempt, use 2 to 4 distinctive source-order tokens for each long selector
  do not copy a long target line verbatim
  minimize both selector text and unnecessary selector rows
  start with the smallest set of short selectors that can identify the hunk
  if repeated text may make a selector ambiguous:
    add one neighboring short selector before lengthening an existing selector
  only lengthen a selector after a stale or ambiguous failure
  use a range selector for spans over 3 lines
  retain accurate line-anchor and retry-patch guidance

in smart-profile examples:
  remove the redundant basic sampled-selector insertion example
  keep one example per distinct lesson: range, token subsequence, character subsequence
  show a long copied code-line selector as the bad form
  show a 2-token sampled subsequence selector as the preferred form
  explain that sampled source-order tokens can skip words between them
  show a long target line without whitespace-delimited words
  show a shorter selector whose sampled characters stay in source order
  explain that smart matching falls through to character subsequence for this case
```
