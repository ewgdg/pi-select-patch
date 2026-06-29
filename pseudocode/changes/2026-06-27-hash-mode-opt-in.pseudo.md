---
affects:
  - src/index.ts
  - src/content-diff.ts
  - src/tools/locator-patch.ts
---

# Hash Mode Opt-In

## Intent

Allow locator-patch to switch into all-in hash mode by config or environment override while keeping the existing compact-status behavior as the default.

## Behavior

```pseudo
on session start:
  read hashMode from extension config.json, overridden by PI_LOCATOR_PATCH_HASH_MODE when present
  ignore project-local configuration for hash mode
  active tools := current active tools without edit, write, locator_read, locator_patch
  if hashMode is true:
    also remove read
  enable read_hash and patch

when patch succeeds or dry-run validates:
  if hashMode is false:
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