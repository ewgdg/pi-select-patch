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
  dry_run?: boolean;
}
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
*** Delete File: old.txt
*** End Patch
```

Update hunks are located by exact contiguous sequence of context/delete hashes. Context/delete operations contain only the 4-character hash (` HHHH`, `-HHHH`); insert operations contain literal new content (`+new text`). Exactly one match is required. No fuzzy fallback, line-number matching, duplicate counters, or perfect hashing.

Success output is compact and model-visible: file operation headers plus hash-only receipt/status. Full content diff is not shown in model-visible output; it stays in `details.diff`. In Pi TUI, the `patch` result renderer uses `details.diff` for the human view: collapsed output shows a compact colorized diff preview, and expanded output shows a much larger diff window.

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

Delete File uses Codex behavior: the section contains only `*** Delete File: path`. It hard-deletes the resolved regular file after validation. Deleted content is omitted from visible output; `details.diff` contains full content diff for UI/host.

## Validate

```sh
npm install
npm run typecheck
npm test
npm run validate
```
