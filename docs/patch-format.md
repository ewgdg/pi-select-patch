# Hashline patch format

## Hashlines

Each logical text line renders as:

```text
HASH│content
```

`HASH` is first 3 bytes of SHA-256 over line content encoded as unpadded base64url, exactly 4 characters. Line terminators are excluded. Duplicate content produces same hash.

Files are UTF-8 text. UTF-8 BOM is preserved for updates. Original first newline convention (`LF`, `CRLF`, or `CR`) and final-newline state are preserved on update write. Empty file has zero logical lines.

## Universal patch

Preferred `patch` input is Codex-like and carries file paths. The tool accepts either inline `patch` text or `patch_file`; provide exactly one. `patch_file` paths resolve against the tool cwd; file paths inside the patch also resolve against cwd, not the patch file directory.

```diff
*** Begin Patch
*** Add File: new.txt
+literal new file line
*** Update File: existing.txt
@@
 HHHH
-HHHH
 HHHH
@@
 HHHH
 ...
+literal insertion after skipped context
 HHHH
@@
 HHHH
-...
+literal replacement content
 HHHH
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
- New file content is written as rows joined with `\n`; no implicit final newline is added.
- Visible receipt exposes only header and `+HASH` rows, never content.

## Update File

Update sections use hashline hunks:

```diff
@@
 HHHH
-HHHH
+literal inserted content
@@
 HHHH
 ...
+literal insertion after skipped context
 HHHH
@@
 HHHH
-...
+literal replacement content
 HHHH
```

Rules:

- Hunk header must be exactly `@@`.
- No source line numbers, duplicate counters, perfect hashes, or fuzzy anchors.
- Operation prefixes: space = context, `-` = delete, `+` = insert.
- Context/delete operations accept hash-only (` HHHH`, `-HHHH`), hash+text (` HHHH│text`, `-HHHH│text`), or text-only (` │text`, `-│text`) locators using Unicode `│`; ASCII `|` is not special. Hash+text requires both hash and exact text to match. Insert operations contain literal content after `+`.
- ` ...` preserves every target line between the nearest surrounding context operations while avoiding long context in the patch.
- `-...` deletes every target line between the nearest surrounding context operations. Add `+` lines after it to replace that range.
- Hunks without ellipsis must match exactly one contiguous span in current target file. Hunks with ellipsis must match exactly one sparse span.
- Zero matches = stale hunk. More than one match = ambiguous hunk.
- Pure insertion has empty match sequence and is supported only when target file has zero logical lines.

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

Deleted hashes are omitted from visible output. If receipt has no surviving context or inserted hashes, or exceeds visible output caps, patch still writes after valid apply and returns compact status telling caller to use `read`.

## `details.diff`

Tool result details include `details.diff`: a human patch transcript for host/UI. Add entries show added input lines, update entries show resolved hunk transcript lines, and delete entries summarize deletion without dumping deleted content. This diff is not placed in model-visible output. Pi TUI human rendering reads this field and shows a colorized preview in collapsed mode, with a larger transcript view when expanded.

## Collision risk

4-character hashes expose 24 bits. Collisions are accepted behavior. Hash-only locators match by hash only. Hash+text locators also compare exact target content, which reduces collision risk. Context lines in receipt preserve actual target hashes after apply.
