---
affects:
  - src/patch-format.ts
  - src/apply.ts
  - src/universal-patch-format.ts
  - src/tools/patch-render.ts
  - src/tools/locator-patch.ts
  - README.md
  - docs/patch-format.md
---

# Smart locator opt-in pseudocode

Goal: add explicit `~` text locator for context/delete rows only. Existing locator rows and unified-diff rows keep current behavior. Insert rows beginning `+~` stay literal insert content.

## Parse

For each hunk operation row:
- If row is an insert (`+...`): parse exactly as existing insert content.
- If row is context/delete and selector starts with `~`:
  - content = text after `~`.
  - Reject when content is empty.
  - Return match op with `smart: true`, `content`, and exact text selector as authored base form.
- If row itself starts with `~`: parse as omitted-space context smart locator.
- Otherwise use existing locator/unified-diff parsing unchanged.

## Apply

For each hunk:
- Validate hunk as today.
- If hunk has no smart match ops: run existing match flow unchanged.
- If hunk has any smart match op:
  - Keep fixed explicit locators on their normal predicate.
  - For each candidate hunk span/assignment, each smart row independently resolves against its assigned target line using the first matching line-level kind: exact, prefix/suffix, contains, then token-subsequence.
  - Prefix/suffix have the same rank for dominance; record the actual resolved `prefix` or `suffix` kind for audit.
  - Collect whole-hunk candidates using same contiguous/sparse, anchor, range, and touched-line behavior as existing apply. Do not stop at the first weaker candidate.
  - Score each candidate by smart op indexes in hunk order. Candidate A dominates B when A is no worse on every smart row rank and better on at least one row. Equal score vectors do not dominate.
  - If candidate exploration exceeds the named safety cap, fail ambiguous instead of guessing.
  - If no candidate matches: throw stale.
  - If exactly one non-dominated candidate remains: apply that candidate and record per-row smart matcher kinds for audit.
  - If multiple non-dominated candidates remain: throw ambiguous.

## Smart predicates and guards

- exact: target line equals query exactly; no broad guard beyond non-empty parser requirement.
- prefix/suffix: query is useful broad text, then target starts with query or ends with query.
- contains: query is useful broad text, then target includes query.
- token-subsequence: query is useful broad text and has at least two whitespace tokens, then those tokens appear in that target line's whitespace tokens in order with gaps allowed.
- Useful broad text guard is deterministic: trimmed query is nonblank, has a minimum useful length, and contains at least one alphanumeric character.
- Tokenization is whitespace only. No character subsequence matching.

## Audit/render/serialization/docs

- Match pattern can keep `~query` so authors see smart locators round-trip.
- Matcher kinds expose each smart row's resolved kind: `exact`, `prefix`, `suffix`, `contains`, or `subsequence`.
- Universal serialization writes smart match ops back as ` ~query` or `-~query`.
- Renderer stats count `subsequence` from matcher kinds.
- Docs describe `~` as opt-in smart locator and list independent per-row resolution, dominance, ambiguity, and stale rules.
