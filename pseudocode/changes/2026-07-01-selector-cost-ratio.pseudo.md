---
affects:
  - src/apply.ts
  - src/selector-efficiency.ts
  - src/tools/selector-patch.ts
  - src/tools/patch-render.ts
---

# Selector cost ratio

## Intent

Report selector authored-character cost as a simple percentage of the equivalent unified-diff baseline, so agents can see selector compactness without warning noise.

## Behavior

```pseudo
when applying or dry-running a patch succeeds:
  compute normal patch char efficiency exactly as before

  compute selector cost only from selector rows:
    for update hunks:
      context/delete selector rows contribute authored selector characters
      matched context/delete target lines contribute canonical unified-diff baseline characters
      context/delete range rows contribute authored range selector characters
      matched range target lines contribute canonical unified-diff baseline characters
      insert rows contribute nothing
    for add-file, delete-file, and pure insertion hunks:
      selector authored chars = 0
      selector baseline chars = 0

  attach aggregate {patchChars, baselineChars} as selectorEfficiency in result details

when formatting successful model-visible output or rendering successful patch result:
  keep existing receipt/status, matcher, and patch efficiency output
  if selector baseline chars > 0:
    append muted/plain metric:
      Selector cost: <ratio>%
```
