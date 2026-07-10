---
affects:
  - src/apply.ts
  - src/tools/selector-patch.ts
  - src/tools/patch-render.ts
  - src/patch-size.ts
---

# Full patch size comparison

## Intent

Compare complete normalized patch input against the equivalent exact unified-diff form with an unambiguous size metric.

## Behavior

```pseudo
when a patch or dry-run succeeds:
  count authored patch characters from the complete normalized accepted input:
    include file headers, hunk headers, optional outer boundaries, body rows, and line separators

  derive equivalent unified-diff size using the same framing:
    replace selector and range body rows with exact matched context/delete rows
    replace intra-line replacement rows with exact delete and insert rows
    keep literal insert and add-file rows unchanged
    adjust line-separator count when expansion changes the number of body rows

  for an exact context row matching an empty logical line:
    serialize the unified-diff baseline as a physically blank row
    count zero row characters instead of a redundant context-space character

  attach details.patchSize:
    patchChars = complete normalized authored size
    unifiedDiffChars = complete equivalent exact unified-diff size

when rendering a successful patch result:
  do not render selector cost
  if unifiedDiffChars is positive:
    render "Patch size: <patch> vs <unified> chars (<difference> than unified diff)"
    describe the difference as smaller, larger, or same
  otherwise omit the size footer

keep selectorEfficiency as structured metadata only
```
