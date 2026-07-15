# pi-select-patch

Pi extension for token-efficient file edits using various efficient selectors.

File edits by coding agents often spend more tokens repeating unchanged code than describing the change. `pi-select-patch` exists to cut that waste.

Design goal: make the smallest patch that still identifies one exact place. Agents should send only the useful anchors and changed lines, not copy whole functions for context.

Smart profile is the default and intended way to use the extension. Its selectors can be short, sampled pieces of a target line. The matcher works out whether each piece is an exact match, prefix, suffix, contained text, token subsequence, fuzzy token subsequence, or character subsequence.

Short does not mean loose. A hunk applies only when its selectors identify one winner. Ambiguous or stale patches fail instead of guessing.

## Smart selectors

No configuration needed. Smart profile is active by default and keeps Pi's built-in `read` tool.

Patch rows retain familiar diff operators:

- ` <selector>` matches a context line.
- `-<selector>` matches and deletes a line.
- `+<content>` inserts literal content.
- ` ...` preserves the range between surrounding selectors.
- `-...` deletes the range between surrounding selectors.
- `/old` followed by `=new` replaces text inside the previous matched line.

Selector text does not need a match-type marker. Start with the shortest readable fragment likely to identify the line. Add another selector, more text, or a line-range hint only when needed to remove ambiguity.

```diff
*** Update File: src/config.ts
@@
 function loadConfig
-const timeoutMs = 5000
+const timeoutMs = 3000
```

Smart matching tries stronger interpretations before weaker ones:

1. exact
2. prefix or suffix
3. contained text
4. whitespace token subsequence
5. bounded fuzzy token subsequence
6. character subsequence

Each row resolves independently. The whole hunk must still have one unambiguous match.

## Token-saving toolbox

### Short sampled selectors

A selector can keep only distinctive words or characters from a long line:

```diff
*** Update File: src/client.ts
@@
-long_obj.long_call(arg)
+replacement(arg)
```

The sampled selector can match `long_object_name.long_function_call(long_arg_name)` without repeating the full line.

### Sparse ranges

Use ranges instead of listing a large unchanged or deleted block:

```diff
*** Update File: src/legacy.ts
@@
 function legacyHandler
-{
-...
-return result
-}
```

### Line-range hints

Limit matching to a known part of a file without copying extra context:

```diff
*** Update File: src/server.ts
@@ @120...160
 timeoutMs
/5000
=3000
```

### Multi-file patches

One call can update several files. File sections run in authored order.

```diff
*** Update File: src/config.ts
@@
-old value
+new value
*** Update File: test/config.test.ts
@@
-old expectation
+new expectation
```

## `patch`

Provide exactly one of `patch` or `patch_file`. Patch files and target file paths resolve from tool working directory.

```ts
{
  patch?: string;
  patch_file?: string;
  dry_run?: boolean;
  receipt?: "status" | "hash";
}
```

File operations:

- `*** Update File: path` updates existing UTF-8 text files.
- Use Pi's built-in `write` tool for new files.
- Whole-file deletion is not supported by `patch`.

Hunk headers:

- `@@` searches whole file.
- `@@ @<line>` and `@@ @<start>...<end>` use strict hard boundaries by default.
- Set global `pi-select-patch.anchorMode` to `"tolerant"` (or `PI_SELECT_PATCH_ANCHOR_MODE=tolerant`) to recover unique overlapping or outside matches hierarchically. Every tolerated application emits a warning with its anchor and resolved span.

Within one file section, later hunks can only match untouched original lines. Use another `*** Update File` section for same path when a later edit must depend on earlier output.

## Failure behavior

Zero matches mean patch is stale. Multiple equally valid matches mean patch is ambiguous. Both fail without changing that operation.

File operations apply sequentially. If a later operation fails, earlier successful operations remain applied and later operations are skipped. Error includes a retry patch containing failed and skipped operations, avoiding need to resend whole original patch.

Dry runs validate and return normal receipt shape without writing.

## Pi integration

Extension registers `patch`, keeps built-in `write`, and hides built-in `edit` plus old selector tool names. Smart profile also keeps built-in `read`.

Set profiles and anchor policy under `pi-select-patch.profile` and `pi-select-patch.anchorMode` in the global `~/.pi/agent/settings.json`. `PI_SELECT_PATCH_PROFILE` and `PI_SELECT_PATCH_ANCHOR_MODE` take precedence. Anchor mode defaults to `strict`; use `tolerant` only when visible stale-anchor recovery is appropriate.

Alternative profiles and full format details live in [docs/patch-format.md](docs/patch-format.md). Smart profile remains recommended default.
