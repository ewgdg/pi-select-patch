# Hashline patch format

## Hashlines

Each logical text line renders as:

```text
HASH│content
```

`HASH` is first 3 bytes of SHA-256 over line content encoded as unpadded base64url, exactly 4 characters. Line terminators are excluded. Duplicate content produces same hash.

Files are UTF-8 text. UTF-8 BOM is preserved for updates. Original first newline convention (`LF`, `CRLF`, or `CR`) and final-newline state are preserved on update write. Empty file has zero logical lines.

## Universal patch

Preferred `patch` input is Codex-like and carries file paths:

```diff
*** Begin Patch
*** Add File: new.txt
+literal new file line
*** Update File: existing.txt
@@
 HHHH
-HHHH
+literal inserted content
*** Delete File: old.txt
@@
-HHHH
*** End Patch
```

Supported section headers:

- `*** Add File: path`
- `*** Update File: path`
- `*** Delete File: path`

Patch must start with `*** Begin Patch` and end with `*** End Patch`. One operation per path is supported.

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
```

Rules:

- Hunk header must be exactly `@@`.
- No source line numbers, ranges, duplicate counters, perfect hashes, or fuzzy anchors.
- Operation prefixes: space = context, `-` = delete, `+` = insert.
- Context/delete operations contain only a hash (` HHHH`, `-HHHH`). Insert operations contain literal content after `+`.
- Sequence must match exactly one contiguous span in current target file.
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

Tool result details include `details.diff`: unified diff with real file content for host/UI. It covers add, update, and delete. This diff is not placed in model-visible output. Pi TUI human rendering reads this field and shows a colorized diff preview in collapsed mode, with a larger diff view when expanded.

## Collision risk

4-character hashes expose 24 bits. Collisions are accepted behavior. Apply uses hashes only; it does not compare target content to patch content after locating a hunk. Context lines in receipt preserve actual target hashes after apply.
