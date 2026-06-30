# pi-locator-patch

Pi extension for token-efficient file edits using explicit locator patches.

The package registers `patch` for multi-file add/update/delete patch application. In hash mode, the hash-line reader is exposed as `read`; outside hash mode, `read_hash` stays hidden and built-in `read` stays active.

Core design: keep patches short while staying exact. Use concise locators and ` ...` / `-...` to skip or replace large unchanged ranges. Ambiguous or stale hunks fail instead of guessing.

On session start, the extension removes mutable built-in tools (`edit`, `write`), `read_hash`, and old locator tool names. Built-in `read` remains active unless hash mode is explicitly enabled; then hash-line `read` replaces it.

## Hash mode opt-in

Hash mode makes hash-line `read` the only read path and changes patch success output to a compact hash receipt.

Enable in `~/.pi/agent/extensions/pi-locator-patch/config.json`:

```json
{
  "hashMode": true
}
```

Quick switch for testing:

```bash
PI_LOCATOR_PATCH_HASH_MODE=1 pi   # force hash mode
PI_LOCATOR_PATCH_HASH_MODE=0 pi   # force default mode
```

## `patch`

`patch` accepts Codex-like universal patch text. Provide exactly one of `patch` or `patch_file`; `patch_file` and file paths inside the patch resolve from the tool cwd. Prefer concise, unique locators over long copied context.

```ts
{
  patch?: string;
  patch_file?: string;
  dry_run?: boolean;
}
```

```diff
*** Begin Patch
*** Add File: new.txt
+literal new file line
*** Update File: existing.txt
@@
 :exact context text
-*needle to delete by containment
+literal inserted line
@@ @120...140
 :start context text
 ...
+literal insertion after skipped context
 :end context text
*** Delete File: old.txt
*** End Patch
```

### File operations

- `*** Add File: path` creates a new UTF-8 text file. Body rows must start with `+`; text after `+` is literal file content.
- `*** Update File: path` applies locator hunks to an existing UTF-8 text file.
- `*** Delete File: path` hard-deletes an existing regular text file. Delete sections have no body.

Multiple operations may target the same path. File operations run in authored order, so a later `*** Update File` section can match output created by an earlier section.

### Update hunks

Hunk headers:

- `@@` — search whole file.
- `@@ @<line>` — search at or after 1-based line.
- `@@ @<start>...<end>` — require resolved match span inside inclusive line range.

Rows inside update hunks:

- ` <locator>` — context line; used only for matching/anchoring.
- `-<locator>` — delete matched line.
- `+<content>` — insert literal line content.

Locators:

- `:<text>` exact line text, e.g. ` :const x = 1;`
- `^<prefix>` line starts with prefix.
- `*<needle>` line contains text.
- `$<suffix>` line ends with suffix.
- `?{...}` combined JSON locator with `prefix`, `contains`, and/or `suffix`.
- `~<text>` opt-in smart text locator for context/delete rows.
- `...` range between surrounding matchers: ` ...` preserves, `-...` deletes.

Hash prefix locator `#<hash>` is preferred in hash mode when `read` supplies a visible hash. In default mode, prefer text locators; use hash locators only for hashes already known from prior receipts or other trusted context. Use text locators when a line has no visible hash or when content predicates are clearer.
Context locator rows may start with a literal space, or omit it. For example, `^prefix` is equivalent to ` ^prefix`, `~target text` is equivalent to ` ~target text`, and `...` is equivalent to ` ...`. Use ` :` or `:` for exact text, including indented lines.

Smart `~` locators are explicit only: ` ~target text` or `~target text` for context, `-~old text` for delete. `+~literal` inserts literal `~literal`. For each candidate hunk span, each smart row independently resolves to its strongest line-level match: exact, prefix/suffix, contains, then whitespace token-subsequence. Prefix and suffix have the same rank, but audit records the actual resolved kind. The whole hunk applies only when dominance leaves one non-dominated candidate; tradeoffs or equal score vectors are ambiguous, and zero candidates are stale. Broad prefix/suffix/contains matches require useful nonblank alphanumeric text; token-subsequence also needs at least two query tokens.

Malformed unified-diff rows are tolerated per matcher. A context/delete row without a locator marker treats text after ` ` or `-` as exact line content; bare unified-diff context text without leading space is invalid. Locator matching runs once; zero matches are stale and multiple matches are ambiguous. Within one `*** Update File` section, later hunks may match or span only untouched original target lines. They cannot anchor on or range across lines inserted or already used by earlier hunks in the same section. Use a later `*** Update File` section when a second edit must depend on prior output.

### Output and failure behavior

With hash mode enabled, success output is a compact hash-only receipt. Context rows show only hashes, inserted rows show `+HASH`, and deleted rows are omitted:

```text
*** Add File: new.txt
@@ add file @@
+9Nrk
*** Update File: existing.txt
@@ matched line 12 @@
 Abc1
+Z9xQ
*** Delete File: old.txt
Deleted file
```

If this receipt is too large, output falls back to compact status rows. Dry runs return the same receipt shape without writing. Without hash mode, success output is compact status rows only.

File operations apply sequentially. If a later non-dry operation fails, earlier successful operations stay applied, later operations are skipped, and the error includes a **retry patch** file containing the unapplied operations. Agents can later reuse the retry patch file to avoid re-emitting large output tokens.
