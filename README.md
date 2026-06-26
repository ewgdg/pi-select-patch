# pi-hashline-patch

Pi extension package for stable hashline reads and universal hashline patch apply.

When loaded, extension overrides Pi's built-in `read`, disables built-in `edit` and `write`, and enables only `read` / `patch` for file reads and writes. `patch` can add files, so built-in `write` is hidden.

## Stable hashlines

Stable hashlines are the main contract: a visible line hash is a pure function of the exact line content. It does not depend on file path, line number, neighboring lines, duplicate counters, file-local collision checks, or read range. The same line content gets the same visible hash across files, reads, and runs.

This makes prior reads reusable. If an agent already knows the target line hash, it can patch with that hash later without doing a redundant read first. If it knows only the exact line text, it can use text selector operations such as ` :<text>` or `-:<text>`. `patch` still requires exactly one matching hunk span, so stale or ambiguous patches fail instead of falling back to fuzzy edits.

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
 :exact context text
-:text to delete
+literal inserted line
@@ @120...140
 :start context text
 ...
+literal insertion after skipped context
 #HHHH
@@
 #HHHH
-...
+literal replacement line
 :end context text
*** Delete File: old.txt
*** End Patch
```

Update hunks use operation+selector syntax: ` :<text>` for exact context text, `-:<text>` for exact delete text, `+<text>` for literal insertion, ` #<hash>` for hash context, and `-#<hash>` for hash delete. Hunk headers are `@@`, `@@ @<line>`, or `@@ @<start>...<end>`; `@@ @<line>` starts searching at 1-based line `<line>` and requires the resolved match start to be at or after that line. `@@ @<start>...<end>` requires the resolved match span to stay within inclusive 1-based lines `<start>...<end>`. ` ...` preserves a skipped context range between surrounding context operations; `-...` deletes that range. Do not use read-output `HASH│content` rows as patch operations. Insert operations contain literal new content directly after `+`; do not include hashes in `+` lines unless those hash characters are intended file content. Exactly one contiguous or sparse match is required. No fuzzy fallback, line-number matching, duplicate counters, or perfect hashing.

Success output is compact and model-visible: file operation headers plus hash-only receipt/status. Receipt rows like ` HHHH` and `+HHHH` are status output, not patch hash locator syntax; use ` #HHHH` or `-#HHHH` in patch input. `details.diff` is a human patch transcript for host/UI, not a whole-file diff. Update entries show only the resolved input hunk lines; Delete File omits deleted file content.

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
