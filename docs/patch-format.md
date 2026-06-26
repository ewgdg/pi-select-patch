# Locator patch format

## Optional hash locators

Text reads are plain by default. Pass `includeHashes: true` to render eligible logical text lines as:

```text
HASH│content
```

Short or low-entropy lines may remain plain even with `includeHashes: true`: `trim().length < 8` or entropy `< 10` shows no hash, entropy `< 20` shows 3 chars, otherwise 4. `HASH` is the first 3 or 4 characters of the SHA-256 based full line hash. Line terminators are excluded. Duplicate content produces same full hash and same visible prefix.

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

Patch must start with `*** Begin Patch` and end with `*** End Patch`. One operation per path is supported. File operations apply sequentially: earlier successful operations stay applied if a later non-dry operation fails, and later operations are skipped. During non-dry apply failures, the tool writes a retry patch containing the failed operation plus skipped later operations and includes its path in the error message. `dry_run: true` validates the full patch without writing.

## Add File

- Target must not exist.
- Each body row starts with `+`; text after `+` is literal file content.
- Do not include hashes in `+` lines unless those hash characters are intended file content.
- New file content is written as rows joined with `\n`; no implicit final newline is added.
- Visible receipt exposes only header and `+HASH` rows, never content.

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
- Operations use one operation char plus a selector: ` :<text>` / `-:<text>` = exact context/delete text, ` ^<prefix>` / `-^<prefix>` = prefix context/delete text, ` *<needle>` / `-*<needle>` = contains context/delete text, ` ?{...}` / `-?{...}` = combined context/delete text, ` $<suffix>` / `-$<suffix>` = suffix context/delete text, `+<text>` = literal insertion, ` #<hash>` = hash context, `-#<hash>` = hash delete (3 or 4 base64url characters), ` ...` = skipped context range, `-...` = delete range.
- Combined selector JSON (` ?{...}` / `-?{...}`) must be an object with only `prefix`, `contains`, and `suffix`; at least one key is required. `prefix`/`suffix` must be non-empty strings. `contains` may be a non-empty string or non-empty array of non-empty strings. All supplied predicates must match the same line.
- Do not use read-output `HASH│content` rows as patch operations. Insert operations contain literal content directly after `+` (`+new text`). Do not include hashes in `+` lines unless those hash characters are intended file content.
- ` ...` preserves every target line between the nearest surrounding context operations while avoiding long context in the patch.
- `-...` deletes every target line between the nearest surrounding context operations. Add `+` lines after it to replace that range.
- Hunks without ellipsis must match exactly one contiguous span in current target file. Hunks with ellipsis must match exactly one sparse span.
- Zero matches = stale hunk. More than one match = ambiguous hunk.
- Pure insertion has empty match sequence and is supported only when target file has zero logical lines; hunk anchor hints are rejected on pure insert hunks because there is no resolved match start.

## Delete File

Delete sections match Codex syntax and contain no body:

```diff
*** Delete File: old.txt
```

Delete is a hard delete of the resolved regular file after validation. Validation requires an existing UTF-8 text file. Visible receipt for delete is header plus `Deleted file`; deleted content is not visible.

## Success receipt

`patch` success output is compact, not a full patched file and not a content diff:

```text
*** Add File: new.txt
+HHHH
*** Update File: existing.txt
@@ result
 HHHH
+HHHH
 HHHH
*** Delete File: old.txt
Deleted file
```

Update receipt lines include only:

- ` HHHH` for context lines that survived in current file.
- `+HHHH` for newly inserted lines.

Receipt rows are status output, not patch input syntax. Use ` #HHH`/` #HHHH` for hash context and `-#HHH`/`-#HHHH` for hash delete in patch input.

Deleted hashes are omitted from visible output. If receipt has no surviving context or inserted hashes, or exceeds visible output caps, patch still writes after valid apply and returns compact status.

## `details.diff`

Tool result details include `details.diff`: a human patch transcript for host/UI. Add entries show added input lines, update entries show resolved hunk transcript lines, and delete entries summarize deletion without dumping deleted content. This diff is not placed in model-visible output. Pi TUI human rendering reads this field and shows a colorized preview in collapsed mode, with a larger transcript view when expanded.

## Collision risk

Visible hash locators expose 18 bits at 3 characters or 24 bits at 4 characters. Collisions are accepted behavior. Hash-only locators match by hash prefix only. Use text-only locators when exact content is needed. Context lines in receipt preserve actual target hashes after apply.
