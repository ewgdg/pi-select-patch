---
status: accepted
---

# Use forward-chain resolution

Resolve every `Update File` section as an authored forward chain over one immutable pre-edit source. For each chain position, consider only candidates at or after the current cursor, apply anchor affinity and selector dominance within that suffix, and select the earliest complete non-overlapping chain. This replaces uniqueness-based ambiguity failure because coding models commonly author Codex-style sequential hunks; retries caused by rejecting repeated matches erase the format's token savings.

## Consequences

- Single and multiple hunks choose the earliest viable strongest match instead of failing merely because equivalent candidates remain.
- Complete-chain search may backtrack when an early candidate prevents later hunks from resolving. Candidates dominated at one cursor are not revived in that search state; a different cursor recomputes dominance within its suffix.
- Hunk order is forward-only. Dependent edits use a later `Update File` section, whose cursor resets and whose source includes earlier section output.
- Context-only hunks and inline `@@ <text>` headers act as locators. Trailing locator hunks are invalid.
- Forward selection is quiet in model-visible receipts and recorded in audit metadata.
- The uniqueness-only resolver and `[E_AMBIGUOUS_HUNK]` behavior are removed rather than retained as a separate mode.
