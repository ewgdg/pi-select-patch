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
  patch: string;
  path?: string;    // legacy single-file @@ @@ patches only
  dry_run?: boolean;
}
```

Preferred syntax is Codex-like universal patch text:

```diff
*** Begin Patch
*** Add File: new.txt
+literal new file line
*** Update File: existing.txt
@@ @@
 HHHH│context
-HHHH│deleted
+HHHH│inserted
*** Delete File: old.txt
@@ @@
-HHHH│old file line
*** End Patch
```

Update hunks are located by exact contiguous sequence of context/deletion hashes. Exactly one match is required. No fuzzy fallback, line-number matching, duplicate counters, or perfect hashing.

Success output is compact and model-visible: file operation headers plus hash-only receipt/status. Full content diff is not shown in visible output; host/UI can read `details.diff`.

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

Delete File uses hard delete after validation. It requires delete-only hashline evidence covering the complete current file, so accidental partial delete is rejected. Deleted content is omitted from visible output; `details.diff` contains full content diff for UI/host.

## Validate

```sh
npm install
npm run typecheck
npm test
npm run validate
```
