# pi-hashline-patch

Pi extension package for stable hashline reads and universal hashline patch apply.

When loaded, extension overrides Pi's built-in `read`, disables built-in `edit` and `write`, and enables only `read` / `patch` for file reads and writes. `patch` can add files, so built-in `write` is hidden.

## Tools

### `read`

Input:

```ts
{
  path: string;
  offset?: number; // default 1
  limit?: number;  // default 2000, max 2000
}
```

For text files, output text contains only rows:

```text
HASH│content
```

No line numbers, duplicate counters, or metadata rows are added. Image files (`jpg`, `png`, `gif`, `webp`) delegate to Pi's built-in `read` behavior and are returned as image reads, not hashlines.

### `patch`

Input:

```ts
{
  patch?: string;
  patch_file?: string;
  dry_run?: boolean;
}

// Provide exactly one of patch or patch_file. patch_file resolves against cwd.
```

Preferred syntax is Codex-like universal patch text:

```diff
*** Begin Patch
*** Add File: new.txt
+literal new file line
*** Update File: existing.txt
@@
 HHHH
-HHHH
+literal inserted line
@@
 HHHH
 ...
+literal insertion after skipped context
 HHHH
@@
 HHHH
-...
+literal replacement line
 HHHH
*** Delete File: old.txt
*** End Patch
```

Update hunks are located by exact context/delete locators. Context/delete operations accept hash-only (` HHHH`, `-HHHH`), hash+text (` HHHH│text`, `-HHHH│text`), or text-only (` │text`, `-│text`) forms using Unicode `│`; ASCII `|` is not special. Hash+text requires both hash and exact text to match. ` ...` preserves a skipped context range between surrounding context operations; `-...` deletes that range; insert operations contain literal new content (`+new text`). Exactly one contiguous or sparse match is required. No fuzzy fallback, line-number matching, duplicate counters, or perfect hashing.

Success output is compact and model-visible: file operation headers plus hash-only receipt/status. `details.diff` is a human patch transcript for host/UI, not a whole-file diff. Update entries show only the resolved input hunk lines; Delete File omits deleted file content.

File operations apply sequentially. If a later non-dry operation fails, earlier successful operations stay applied, later operations are skipped, and the error includes a retry patch file path containing the failed operation plus skipped later operations. `dry_run: true` validates the full patch without writing.

```text
*** Add File: new.txt
+HHHH
*** Update File: existing.txt
@@ result
 HHHH
+HHHH
*** Delete File: old.txt
Deleted file
```

Delete File uses Codex behavior: the section contains only `*** Delete File: path`. It hard-deletes the resolved regular file after validation. Deleted content is omitted from visible output and human diff details.

## Validate

```sh
npm install
npm run typecheck
npm test
npm run validate
```
