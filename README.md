# pi-locator-patch

Pi extension for token-efficient file edits using explicit locator patches.

The package registers `patch` for multi-file add/update/delete patch application.

Core design: keep patches short while staying exact. Use the shortest unique locator that explains the target, such as prefix/contains/suffix locators instead of full-line text, and `=...` / `-...` to skip or replace large unchanged ranges. Ambiguous or stale hunks fail instead of guessing.

On session start, the extension removes mutable built-in tools (`edit`, `write`) and old locator tool names.

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
=:exact context text
-*needle to delete by containment
+literal inserted line
@@ @120...140
=:start context text
=...
+literal insertion after skipped context
=:end context text
*** Delete File: old.txt
*** End Patch
```

### File operations

- `*** Add File: path` creates a new UTF-8 text file. Body rows must start with `+`; text after `+` is literal file content.
- `*** Update File: path` applies locator hunks to an existing UTF-8 text file.
- `*** Delete File: path` hard-deletes an existing regular text file. Delete sections have no body.

One operation per path is supported.

### Update hunks

Hunk headers:

- `@@` — search whole file.
- `@@ @<line>` — search at or after 1-based line.
- `@@ @<start>...<end>` — require resolved match span inside inclusive line range.

Rows inside update hunks:

- ` <locator>` / `=<locator>` — context line; used only for matching/anchoring.
- `-<locator>` — delete matched line.
- `+<content>` — insert literal line content.

Locators:

- `:<text>` exact line text, e.g. `=:const x = 1;`
- `^<prefix>` line starts with prefix.
- `*<needle>` line contains text.
- `$<suffix>` line ends with suffix.
- `?{...}` combined JSON locator with `prefix`, `contains`, and/or `suffix`.
- `...` range between surrounding matchers: `=...` preserves, `-...` deletes.

Hash prefix locator `#<hash>` also exists for rare fallback cases. Prefer text locators because they are readable and avoid hash collision ambiguity.
Context rows normally start with a literal space; legacy `=` context rows are accepted. Use ` :` or `=:` for exact text, including indented lines.

Malformed unified-diff rows are tolerated per matcher. A context/delete row without a locator marker treats text after ` `, `=`, or `-` as exact line content. If locator matching finds zero spans, the hunk retries once with every context/delete row treated as unified-diff exact text. Multiple matches still fail as ambiguous.

### Output and failure behavior

Success output is compact status only:

```text
*** Add File: new.txt
Applied
*** Update File: existing.txt
Applied
*** Delete File: old.txt
Deleted file
```

Dry runs return `Validated` instead of writing.

File operations apply sequentially. If a later non-dry operation fails, earlier successful operations stay applied, later operations are skipped, and the error includes a **retry patch** file containing the unapplied operations. Agents can later reuse the retry patch file to avoid re-emitting large output tokens.
