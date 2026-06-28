# Locator patch format

## Optional hash locators

Use `read` in hash mode to render logical text lines as:

```text
HASH│content
│content without a visible hash
```

Short or low-entropy lines still include the `│` marker but no visible hash: `trim().length < 8` or entropy `< 10` shows no hash, entropy `< 20` shows 3 chars, otherwise 4. `HASH` is the first 3 or 4 characters of the SHA-256 based full line hash. Line terminators are excluded. Duplicate content produces same full hash and same visible prefix.

Hash mode is opt-in. Set `hashMode: true` in `~/.pi/agent/pi-locator-patch.json`, or use `PI_LOCATOR_PATCH_HASH_MODE=1` / `0` to force it for quick testing. In hash mode, built-in `read` is replaced by the hash-line `read`, and patch success output uses the hash receipt described below. Outside hash mode, `read_hash` is hidden and built-in `read` stays active.

Files are UTF-8 text. UTF-8 BOM is preserved for updates. Original first newline convention (`LF`, `CRLF`, or `CR`) and final-newline state are preserved on update write. Empty file has zero logical lines.

## Universal patch

Preferred `patch` input is Codex-like and carries file paths. The tool accepts either inline `patch` text or `patch_file`; provide exactly one. `patch_file` paths resolve against the tool cwd; file paths inside the patch also resolve against cwd, not the patch file directory.

```diff
*** Begin Patch
*** Add File: new.txt
+literal new file line
*** Update File: existing.txt
@@
 :exact context text
-:text to delete
 #HHHH
@@ @120...140
 :start context text
 ...
+literal insertion after skipped context
 :end context text
@@
 #HHHH
-...
+literal replacement content
 :end context text
*** Delete File: old.txt
*** End Patch
```

Supported section headers:

- `*** Add File: path`
- `*** Update File: path`
- `*** Delete File: path`

Patch must start with `*** Begin Patch` and end with `*** End Patch`. Multiple operations may target the same path. File operations apply sequentially: earlier successful operations stay applied if a later non-dry operation fails, and later operations are skipped. During non-dry apply failures, the tool writes a retry patch containing the failed operation plus skipped later operations and includes its path in the error message. Parser failures write the raw malformed input as the retry patch so agents can fix it via `patch_file` without re-emitting the full patch. `dry_run: true` validates the full patch without writing.

## Add File

- Target must not exist.
- Each body row starts with `+`; text after `+` is literal file content.
- Do not include hashes in `+` lines unless those hash characters are intended file content.
- New file content is written as rows joined with `\n`; no implicit final newline is added.
- In hash mode, visible receipt exposes the Add File header, `@@ add file @@`, and inserted content rows. Without hash mode, visible status is the Add File header plus `Applied`.

## Update File

Update sections use locator hunks:

```diff
@@
 :exact context text
-:text to delete
+literal inserted content
@@ @120...140
 :start context text
 *middle needle
 ?{"prefix":"start","contains":["middle","needle"],"suffix":"end"}
 ...
+literal insertion after skipped context
 #HHHH
@@
 #HHHH
-...
+literal replacement content
 :end context text
```

Rules:

- Hunk header must be `@@`, `@@ @<line>`, or `@@ @<start>...<end>`. `@@ @<line>` starts searching at 1-based line `<line>` and requires the resolved match start to be at or after that line. `@@ @<start>...<end>` requires the resolved match span to stay within inclusive 1-based lines `<start>...<end>`.
- No source/destination diff ranges, duplicate counters, perfect hashes, or fuzzy anchors.
- Context/delete rows use `<operator><locator>` syntax: `<operator>` is a space for context or `-` for delete; `<locator>` is `:`, `^`, `*`, `?`, `$`, `#`, or `...` plus selector-specific text, hash, or JSON. Forms: ` :<text>` / `-:<text>` = exact context/delete text, ` ^<prefix>` / `-^<prefix>` = prefix context/delete text, ` *<needle>` / `-*<needle>` = contains context/delete text, ` ?{...}` / `-?{...}` = combined context/delete text, ` $<suffix>` / `-$<suffix>` = suffix context/delete text, ` #<hash>` / `-#<hash>` = hash context/delete (3 or 4 base64url characters), ` ...` = skipped context range, `-...` = delete range. Insert rows use `+<content>` and have no selector.
  Context rows start with a literal space. Use ` :` for exact text, including indented lines. A context/delete row without a locator marker is parsed as unified diff: text after ` ` or `-` is exact line content. A blank hunk row means an empty context line.
- Combined selector JSON (` ?{...}` / `-?{...}`) must be an object with only `prefix`, `contains`, and `suffix`; at least one key is required. `prefix`/`suffix` must be non-empty strings. `contains` may be a non-empty string or non-empty array of non-empty strings. All supplied predicates must match the same line.
- Do not use hash-line read output rows (`HASH│content`) as patch operations. Insert operations contain literal content directly after `+` (`+new text`). Do not include hashes in `+` lines unless those hash characters are intended file content.
- ` ...` preserves every target line between the nearest surrounding context/delete operations while avoiding long context in the patch.
- `-...` deletes every target line between the nearest surrounding context/delete operations. Add `+` lines after it to replace that range. Surrounding delete operations also anchor the sparse range, then delete their matched endpoint lines.
- Hunks without ellipsis must match exactly one contiguous span in current target file. Hunks with ellipsis must match exactly one sparse span.
- Within one Update File section, each hunk may match or span only untouched original target lines. Later hunks cannot anchor on or range across inserted lines or target lines already used by earlier hunks in that same section. To make one edit depend on another edit's output, use a later `*** Update File` section for the same path.
- Pure insertion has empty match sequence and is supported only when target file has zero logical lines; hunk anchor hints are rejected on pure insert hunks because there is no resolved match start.

### Blank line operations

`:` is the exact-text locator; with no text after it, it matches an empty logical line.

This patch deletes one of two blank lines and inserts one blank line at the end of the matched span:

```text
before


after
```

```diff
*** Begin Patch
*** Update File: existing.txt
@@
 :before
 :
-:
 :after
+
*** End Patch
```

Use ` :` to match a blank context line, `-:` to delete a blank line, and `+` with no following text to insert a blank line.

Result has one blank line between `before` and `after`, plus one blank line after `after`:

```text
before

after

```

## Delete File

Delete sections match Codex syntax and contain no body:

```diff
*** Delete File: old.txt
```

Delete is a hard delete of the resolved regular file after validation. Validation requires an existing UTF-8 text file. Visible status for delete is header plus `Deleted file`; deleted content is not visible.

## Success receipt

With hash mode enabled, `patch` success output is a compact hash-only receipt, not a full patched file:

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

Update receipts show hunk headers, surviving context line hashes, and inserted-line hashes. Deleted rows are omitted. Delete receipts show only the operation header and `Deleted file`. If the receipt exceeds visible output limits, the tool falls back to compact status rows with `Applied`, `Validated`, or `Deleted file`. Without hash mode, success output is compact status rows only.

## `details.diff`

Tool result details include `details.diff`: a human patch transcript for host/UI. Add entries show added input lines, update entries show resolved hunk transcript lines, and delete entries summarize deletion without dumping deleted content. This diff is not placed in model-visible output. Pi TUI human rendering reads this field and shows a colorized preview in collapsed mode, with a larger transcript view when expanded.
When patch execution fails, parser errors include an input line number. Pi TUI rendering shows the first error line plus a bounded preview of the actual agent input (`patch` text, or the `patch_file` path); when a line number is available, the inline `patch` preview is centered around that line. Partial apply failures lift the `Failed:` operation and retry patch path above the input preview so the real cause is visible without expanding the tool result.

## Collision risk

Visible hash locators expose 18 bits at 3 characters or 24 bits at 4 characters. Collisions are accepted behavior. Hash-only locators match by hash prefix only. Use text-only locators when exact content is needed. Use hash-line `read` in hash mode, or prior hash-mode patch receipts, to retrieve current target hashes after apply.
