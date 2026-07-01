---
affects:
  - src/patch-format.ts
  - src/apply.ts
  - src/tools/selector-patch.ts
  - src/tools/patch-render.ts
---

# Patch char efficiency footer

## Intent

Show a compact footer metric comparing authored patch body characters against canonical unified-diff body characters for the same applied change.

## Behavior

```pseudo
when applying or dry-running a patch succeeds:
  preserve each parsed hunk operation row's original character count before selector normalization
  compute patch char count from preserved authored patch operation rows, excluding universal wrappers, file headers, and hunk headers
  compute baseline char count from canonical unified-diff operation rows for the exact matched/applied lines
  for Add File:
    patch chars = baseline chars = sum chars of +line rows
  for Delete File:
    patch chars = 0 because delete section has no body rows
    baseline chars = sum chars of -line rows for deleted file text
  for Update File:
    for every applied hunk operation:
      insert row contributes authored +line chars to patch and canonical +line chars to baseline
      context/delete selector row contributes preserved authored row chars to patch
      context/delete matched line contributes canonical unified-diff row chars to baseline
      range selector row contributes authored range row chars to patch
      matched range lines contribute canonical unified-diff rows to baseline
  attach aggregate {patchChars, baselineChars} to tool result details

when rendering successful patch result:
  keep existing success summary and diff preview
  keep existing matcher footer
  always print footer line when char efficiency is available:
    Patch efficiency: <patch>/<baseline> chars vs baseline (<ratio>%, saved <saved>%)
  format ratio and saved with one decimal
  if baseline is zero:
    print n/a instead of percentages
```
