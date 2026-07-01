---
affects:
  - src/index.ts
  - src/content-diff.ts
  - src/tools/selector-patch.ts
---

# Hash Mode Opt-In

## Intent

Allow select-patch to switch into all-in hash profile by profile config or environment override while keeping the existing compact-status behavior as the default.

## Behavior

```pseudo
on session start:
  read profile from extension config.json, overridden by PI_SELECT_PATCH_PROFILE when present
  ignore project-local configuration for hash profile
  active tools := current active tools without edit, write, selector_read, selector_patch
  if profile is hash:
    also remove read
  enable read_hash and patch

when patch succeeds or dry-run validates:
  if profile is classic:
    print compact operation status rows
    return

  for each changed file:
    print universal patch file header
    if operation adds file:
      print "@@ add file @@"
      print inserted file rows as +HASH
    if operation deletes file:
      print "Deleted file"
    if operation updates file:
      for each applied hunk transcript:
        print matched hunk header
        print only surviving context rows and inserted rows
        omit deleted rows
        render context rows as line hashes with a leading space
        render inserted rows as +HASH

if rendered patch receipt exceeds visible output limits:
  return compact operation status instead of leaking partial or oversized content
```