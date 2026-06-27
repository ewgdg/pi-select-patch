# pi-locator-patch

Pi extension package for plain/optional-hash reads and universal hash/text locator patch apply.

When loaded, extension overrides Pi's built-in `read`, disables built-in `edit` and `write`, and enables only `read` / `patch` for file reads and writes. `patch` can add files, so built-in `write` is hidden.

## Optional stable hash locators

Text `read` output is plain content by default. Pass `includeHashes: true` when hash locators are useful. Eligible lines are prefixed as `HASH│content`; short or low-entropy lines stay plain even in hash mode.

Stable hashes are a pure function of exact full line content. They do not depend on file path, line number, neighboring lines, duplicate counters, file-local collision checks, or read range. Visible hashes are 3 or 4 base64url characters depending on trimmed length/entropy (`trim().length < 8` or entropy `< 10` shows no hash; entropy `< 20` shows 3 chars; otherwise 4). `patch` accepts 3- or 4-character hash locators and matches them as prefixes of the full 4-character line hash.

If an agent already knows the target line hash, it can patch with that hash later without doing a redundant read first. If it knows line text, it can use exact text selectors (`=:<text>` / `-:<text>`), prefix selectors (`=^<prefix>` / `-^<prefix>`), contains selectors (`=*<needle>` / `-*<needle>`), combined selectors (`=?{...}` / `-?{...}`), or suffix selectors (`=$<suffix>` / `-$<suffix>`). `patch` still requires exactly one matching hunk span, so stale or ambiguous patches fail instead of falling back to fuzzy edits.

## Tools

### `read`

Input:

```ts
{
  path: string;
  offset?: number; // default 1
  limit?: number;  // default 2000, max 2000
  includeHashes?: boolean; // default false
}
```

For text files, default output contains plain content lines. With `includeHashes: true`, eligible lines are prefixed with variable 3/4-character hashes; lines with visible hash length 0 remain plain:

```text
plain short line
Ab3│content with 3-char hash
Ab3_│content with 4-char hash
```

No line numbers, duplicate counters, or metadata rows are added. Image files (`jpg`, `png`, `gif`, `webp`) delegate to Pi's built-in `read` behavior and are returned as image reads, not transformed into hash-prefixed text rows.

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
=:exact context text
-*needle to delete by containment
+literal inserted line
@@ @120...140
=:start context text
=*middle needle
=?{"prefix":"start","contains":["middle","needle"],"suffix":"end"}
=...
+literal insertion after skipped context
=#HHHH
@@
=#HHHH
-...
+literal replacement line
=:end context text
*** Delete File: old.txt
*** End Patch
```

Update hunk context/delete rows use `<operation><selector><locator>` syntax: `=` or `-` operation, then selector `:`, `^`, `*`, `?`, `$`, `#`, or `...`, then selector-specific locator text/hash/JSON. Forms: `=:<text>` / `-:<text>` for exact context/delete text, `=^<prefix>` / `-^<prefix>` for prefix context/delete text, `=*<needle>` / `-*<needle>` for contains context/delete text, `=?{...}` / `-?{...}` for combined context/delete text, `=$<suffix>` / `-$<suffix>` for suffix context/delete text, `=#<hash>` / `-#<hash>` for hash context/delete (3 or 4 base64url characters). Compatibility only: a context row beginning with one space is exact context text after that space (` literal` equals `=:literal`; a lone space equals `=:`), and selector-looking text after the space stays literal. Insert rows use `+<content>` and have no selector. Hunk headers are `@@`, `@@ @<line>`, or `@@ @<start>...<end>`; `@@ @<line>` starts searching at 1-based line `<line>` and requires the resolved match start to be at or after that line. `@@ @<start>...<end>` requires the resolved match span to stay within inclusive 1-based lines `<start>...<end>`. `=...` preserves a skipped context range between surrounding context operations; `-...` deletes that range. Combined selector JSON must be an object with only `prefix`, `contains`, and `suffix`; at least one key is required. `prefix`/`suffix` must be non-empty strings. `contains` may be a non-empty string or non-empty array of non-empty strings, and every supplied predicate must match the same line. Do not use read-output `HASH│content` rows as patch operations. Insert operations contain literal new content directly after `+`; do not include hashes in `+` lines unless those hash characters are intended file content. Exactly one contiguous or sparse match is required. No fuzzy fallback, line-number matching, duplicate counters, or perfect hashing.

Success output is compact and model-visible: file operation headers plus status lines only. It does not include file content or post-apply hashes; use `read` with `includeHashes: true` when current hashes are needed. `details.diff` is a human patch transcript for host/UI, not a whole-file diff. Update entries show only the resolved input hunk lines; Delete File omits deleted file content.

File operations apply sequentially. If a later non-dry operation fails, earlier successful operations stay applied, later operations are skipped, and the error includes a retry patch file path containing the failed operation plus skipped later operations. `dry_run: true` validates the full patch without writing.

```text
*** Add File: new.txt
Applied
*** Update File: existing.txt
Applied
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
