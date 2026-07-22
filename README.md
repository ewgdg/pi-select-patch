# pi-select-patch

Pi extension for exact literal replacements and token-efficient selector edits.

File edits by coding agents often spend more tokens repeating unchanged code than describing the change. `pi-select-patch` exists to cut that waste.

Design goal: make the smallest patch that still describes the intended forward edit sequence. Agents should send only useful locators, selectors, and changed lines, not copy whole functions for context.

Smart profile is the default and intended way to use the extension. Its selectors can be short, sampled pieces of a target line. The matcher works out whether each piece is an exact match, prefix, suffix, contained text, token subsequence, fuzzy token subsequence, or character subsequence.

Short does not mean unstructured. Selector strength still outranks position, while authored hunk order supplies a Codex-compatible forward search chain for repeated matches.

## Smart selectors

No configuration needed. Smart profile is active by default and keeps Pi's built-in `read` tool.

Patch rows retain familiar diff operators:

- ` <selector>` matches a context line.
- `-<selector>` matches and deletes a line.
- `+<content>` inserts literal content.
- ` ...` preserves the range between surrounding selectors.
- `-...` deletes the range between surrounding selectors.
- `/old` followed by `=new` replaces text inside the previous matched line.

Selector text does not need a match-type marker. Start with the shortest readable fragment that expresses the intended target. Add another selector, more text, or a line-range constraint when stronger evidence is useful.

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

Each row resolves independently within the source suffix available at that chain position. Equal strongest hunk matches remain available for earliest complete forward-chain selection.

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

## `replace`

Use `replace` for exact literal substitution in one existing UTF-8 text file. It is separate from selector editing and has a model-familiar shape:

```ts
{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

Matching is case-sensitive and exact. Replace does not trim, dedent, fuzzy-match, or normalize Unicode. Line endings are canonicalized for matching, so LF, CRLF, and standalone CR inputs can describe the same logical text. The file's initial UTF-8 BOM is preserved and excluded from matching.

By default, `old_string` must occur exactly once. Zero occurrences fail with reread guidance; multiple occurrences fail with the count and ask for more unchanged context. Set `replace_all: true` only when every non-overlapping occurrence should change. An empty `new_string` deletes the matched text.

Replace serializes same-file mutations through Pi's process-local file mutation queue, including symlink aliases. It uses the shared internal text-file publication backend described below.

## `edit`

Use `edit` for selector-based line changes, sparse ranges, and multi-file patches.

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
- Whole-file deletion is not supported by `edit`.

Hunk headers:

- `@@` starts or continues the authored forward chain.
- `@@ <text>` smart-matches an inline locator before resolving that hunk's body.
- `@@ @<line>` and `@@ @<start>...<end>` use strict hard boundaries by default.
- Set global `pi-select-patch.anchorMode` to `"tolerant"` (or `PI_SELECT_PATCH_ANCHOR_MODE=tolerant`) to consider overlapping or outside matches hierarchically. Every tolerated application emits a warning with its anchor and resolved span.

Each `Update File` section resolves against one immutable pre-edit source as an authored forward chain. The cursor begins at the start of the file. For each hunk, candidates before the cursor are ineligible; line-anchor affinity and selector dominance then rank the remaining candidates.

The resolver selects the earliest complete, non-overlapping chain, backtracking when an early candidate prevents later hunks from resolving. Equal starts prefer the earlier end line. This applies to single hunks as well as multi-hunk locator chains. Candidates dominated at the same cursor never return merely to make a chain succeed; backtracking to a different cursor recomputes selector strength within that new suffix.

Context-only hunks act as locators and must lead to a later mutation. A hunk cannot match output inserted by an earlier hunk in the same section; use another `*** Update File` section for dependent edits.

## Failure behavior

A search branch with no forward-eligible candidate is abandoned and the resolver backtracks. A hunk with no source candidate under its selector and anchor rules fails as `[E_STALE_HUNK]`; candidates that exist but cannot form a complete forward non-overlapping chain fail as `[E_FORWARD_CHAIN]`. Candidate or chain-search limits fail explicitly as `[E_HUNK_CANDIDATE_LIMIT]`; limits never choose from truncated evidence. All failures leave that operation unchanged.

File operations apply sequentially. If a later operation fails, earlier successful operations remain applied and later operations are skipped. Error includes a retry patch containing failed and skipped operations, avoiding need to resend whole original patch.

Dry runs validate and return normal receipt shape without writing.

`edit` and `replace` publish complete text through the same internal default backend. Existing files are opened and direct-written in place after symlink resolution, preserving the symlink and the target's mode, inode identity, and hard links where the platform exposes them. Publication does not use temporary files, hard-link publication, or rename publication, and replacing an existing file does not require write permission on its parent directory.

Publication is not atomic. A failed existing-file write may leave the target partially written or truncated; reread the file before retrying. The backend is internal and has no tool parameter, setting, or environment-variable selector.

## Pi integration

Extension registers selector editing as `edit`, replacing Pi's built-in `edit` interface, and keeps built-in `write`. Smart profile also keeps built-in `read`.

Set profiles and anchor policy under `pi-select-patch.profile` and `pi-select-patch.anchorMode` in the global `~/.pi/agent/settings.json`. `PI_SELECT_PATCH_PROFILE` and `PI_SELECT_PATCH_ANCHOR_MODE` take precedence. Anchor mode defaults to `strict`; use `tolerant` only when visible stale-anchor recovery is appropriate.

Alternative profiles and full format details live in [docs/patch-format.md](docs/patch-format.md). Smart profile remains recommended default.
