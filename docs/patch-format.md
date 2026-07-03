# Selector patch format

## Optional hash selectors

Use `read` under `profile: "hash"` to render logical text lines as:

```text
HASH│content
```

Every line includes a visible hash. Width is entropy-based: entropy `< 4` shows 1 char, `< 10` shows 2 chars, `< 24` shows 3 chars, otherwise 4. `HASH` is the first 1 to 4 characters of the SHA-256 based full line hash. Line terminators are excluded. Duplicate content produces same full hash and same visible prefix.

Profiles control session defaults and read registration. Set `profile: "classic" | "smart" | "hash"` in `~/.pi/agent/extensions/pi-select-patch/config.json`, or use `PI_SELECT_PATCH_PROFILE`. Default is `smart`: built-in `read` stays active with smart/status patch defaults. `classic` keeps built-in `read` and exact/status patch defaults; `hash` replaces built-in `read` with hash-line `read` and uses hash/hash patch defaults.

Files are UTF-8 text. UTF-8 BOM is preserved for updates. Original first newline convention (`LF`, `CRLF`, or `CR`) and final-newline state are preserved on update write. Empty file has zero logical lines.

## Universal patch

Preferred `patch` input carries existing file paths in file operation sections. The tool accepts either inline `patch` text or `patch_file`; provide exactly one. `patch_file` paths resolve against the tool cwd; file paths inside the patch also resolve against cwd, not the patch file directory. Legacy `*** Begin Patch` / `*** End Patch` outer boundaries are accepted only as a matching outer pair; preferred input omits them.

```diff
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
```

Prompted section header:

- `*** Update File: path`

Use the built-in `write` tool for new files. `*** Delete File: path` is rejected. Use an explicit shell command for whole-file deletion when needed.

Multiple operations may target the same path. File operations apply sequentially: earlier successful operations stay applied if a later non-dry operation fails, and later operations are skipped. During non-dry apply failures, the tool writes a retry patch by copying the authored failed operation plus skipped later operations, then includes its path in the error message. Parser failures write the raw malformed input as the retry patch so agents can fix it via `patch_file` without re-emitting the full patch. `dry_run: true` validates the full patch without writing.

Patch calls can set `receipt`. `profile` is configuration, not a patch parameter.

- configured `profile: "classic"` — context/delete rows use classic selector markers or exact unified-diff fallback; status receipt.
- configured `profile: "smart"` — unified-diff-style context/delete rows use smart selectors; status receipt.
- configured `profile: "hash"` — update hunk rows are strict by default: only unified-diff-style hash selectors, ranges, and inserts are accepted; hash receipt.

Classic profile is markerful: it parses explicit selector markers. Smart and hash profiles keep unified-diff operators: context rows start with a space, delete rows start with `-`, and only the selector text after the operator changes meaning. `receipt` can be `status` or `hash` and overrides the configured profile receipt default for one call.

## Update File

Update sections use selector hunks:

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
- In classic profile, context/delete rows use `<operator><selector>` syntax. The operator is the leading row action: space or omitted for context, `-` for delete, and `+` for literal insert content. The selector is the match payload after the context/delete operator: `:<text>`, `^<prefix>`, `*<needle>`, `?{...}`, `$<suffix>`, `~<text>`, hash-enabled `#<hash>`, or `...` range. A matcher / match row is operator plus selector. Forms: ` :<text>` / `-:<text>` = exact context/delete text, ` ^<prefix>` / `-^<prefix>` = prefix context/delete text, ` *<needle>` / `-*<needle>` = contains context/delete text, ` ?{...}` / `-?{...}` = combined context/delete text, ` $<suffix>` / `-$<suffix>` = suffix context/delete text, ` ~<text>` / `-~<text>` = opt-in smart context/delete text, hash-enabled ` #<hash>` / `-#<hash>` = hash context/delete (1 to 4 base64url characters), ` ...` = skipped context range, `-...` = delete range. Insert rows use `+<content>` and have no selector; `+~literal` inserts `~literal`.
  In configured `profile: "hash"`, allowed update hunk rows are only hash context/delete selectors (` a`, `-b3`), ranges (` ...`, `-...`), and literal inserts (`+literal`). `#` hash markers and text selectors are rejected.
  In classic profile, context selector rows may start with a literal space, or omit it before an explicit selector marker. For example, `^prefix` is equivalent to ` ^prefix`, `~target text` is equivalent to ` ~target text`, and `...` is equivalent to ` ...`. Use ` :` or `:` for exact text, including indented lines and literal leading `#` text. Smart profile treats context rows as smart text after the leading space operator and delete rows as smart text after `-`; marker-looking selector text is literal. A blank hunk row always means an empty context line.
- Combined selector JSON (` ?{...}` / `-?{...}`) must be an object with only `prefix`, `contains`, and `suffix`; at least one key is required. `prefix`/`suffix` must be non-empty strings. `contains` may be a non-empty string or non-empty array of non-empty strings. All supplied predicates must match the same line.
- Smart selectors in classic profile (` ~<text>` / `-~<text>`, omitted-space context `~<text>`) and smart profile selector rows resolve independently to their strongest line-level match: exact, prefix/suffix, contains, whitespace token-subsequence, bounded fuzzy token-subsequence, then character subsequence. Fixed explicit selectors in the same hunk keep their normal predicate. Prefix/suffix have the same rank, but audit records the actual resolved kind. The whole hunk applies only when dominance leaves one non-dominated candidate; tradeoffs or equal score vectors are ambiguous, and zero candidates are stale. Character subsequence is the weakest tier and only runs for useful non-whitespace query length.
- Do not use hash-line read output rows (`HASH│content`) as patch operations. Insert operations contain literal content directly after `+` (`+new text`). Do not include hashes in `+` lines unless those hash characters are intended file content.
- ` ...` preserves every target line between the nearest surrounding context/delete operations while avoiding long context in the patch.
- `-...` deletes every target line between the nearest surrounding context/delete operations. Add `+` lines after it to replace that range. Surrounding delete operations also anchor the sparse range, then delete their matched endpoint lines.
- Hunks without ellipsis must match exactly one contiguous span in current target file. Hunks with ellipsis must match exactly one sparse span.
- Within one Update File section, each hunk may match or span only untouched original target lines. Later hunks cannot anchor on or range across inserted lines or target lines already used by earlier hunks in that same section. To make one edit depend on another edit's output, use a later `*** Update File` section for the same path.
- Pure insertion has empty match sequence and is supported only when target file has zero logical lines; hunk anchor hints are rejected on pure insert hunks because there is no resolved match start.

### Blank line operations

`:` is the exact-text selector; with no text after it, it matches an empty logical line.

This patch deletes one of two blank lines and inserts one blank line at the end of the matched span:

```text
before


after
```

```diff
*** Update File: existing.txt
@@
 :before
 :
-:
 :after
+
```

Use ` :` to match a blank context line, `-:` to delete a blank line, and `+` with no following text to insert a blank line.

Result has one blank line between `before` and `after`, plus one blank line after `after`:

```text
before

after

```

## Success receipt

With `profile: "hash"` or `receipt: "hash"`, `patch` success output is a compact hash-only receipt, not a full patched file:

```text
*** Update File: existing.txt
@@ matched line 12 @@
 Abc1
+Z9xQ
```

Update receipts show hunk headers, surviving context line hashes, and inserted-line hashes. Deleted rows are omitted. If the receipt exceeds visible output limits, the tool falls back to compact status rows with `Applied` or `Validated`. With `receipt: "status"`, success output is compact status rows only.

## `details.diff`

Tool result details include `details.diff`: a human patch transcript for host/UI. Update entries show resolved hunk transcript lines. This diff is not placed in model-visible output. Pi TUI human rendering reads this field and shows a colorized preview in collapsed mode, with a larger transcript view when expanded.
Tool result details also include `details.selectorEfficiency`, a selector-only authored-character count versus canonical unified-diff baseline. Insert rows are excluded. When selector baseline characters are available, successful model-visible output and Pi TUI rendering show `Selector cost: <ratio>%`.
When patch execution fails, parser errors include an input line number. Pi TUI rendering shows the first error line plus a bounded preview of the actual agent input (`patch` text, or the `patch_file` path); when a line number is available, the inline `patch` preview is centered around that line. Partial apply failures lift the `Failed:` operation and retry patch path above the input preview so the real cause is visible without expanding the tool result.

## Collision risk

Visible hash selectors expose 6 bits per character: 6, 12, 18, or 24 bits for 1- to 4-character hashes. Collisions are accepted behavior. Hash-only selectors match by hash prefix only. Classic profile parses `#<hash>` marker selectors when hash selectors are enabled by `receipt: "hash"`; configured `profile: "hash"` uses bare hash selectors after unified-diff operators. Malformed hash selectors fail instead of falling back to unified-diff. Use text-only selectors when content predicates are clearer. Use hash-line `read` under `profile: "hash"`, or prior hash receipts, to retrieve current target hashes after apply.
