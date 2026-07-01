---
affects:
  - src/patch-format.ts
---

# Markerless profile rows

## Intent

Only classic profile parses selector markers. Markerless profiles preserve authored selector text exactly, except for operation prefixes (`+` insert and `-` delete).

## Behavior

```pseudo
when parsing a hunk operation row in smart profile:
  if row is an insert:
    parse as insert content after +
  if row is a delete:
    parse all text after - as smart delete text
  otherwise:
    parse the whole row as smart context text
    preserve all leading spaces in the smart context text

when parsing a hunk operation row in classic profile:
  parse explicit selector markers
  support optional omitted context operator only before explicit markers
  preserve classic unified-diff exact context/delete fallback

when parsing a hunk operation row in hash profile:
  if row is an insert:
    parse as insert content after +
  if row is a delete:
    parse selector after - as a hash or delete range
  otherwise:
    parse the whole row as a context hash or context range
    do not remove leading spaces
    do not remove a leading #
    reject the row if the whole selector is not a valid hash or range

when writing a retry patch under hash profile:
  serialize context hashes as the bare hash
  serialize delete hashes as - plus the bare hash
  serialize context ranges as ...
  serialize delete ranges as -...
  do not introduce context marker spaces or # hash markers
```