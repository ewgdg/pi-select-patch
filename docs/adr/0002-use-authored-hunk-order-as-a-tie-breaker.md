---
status: superseded by ADR-0003
---

# Use authored hunk order as a match tie-breaker

**Superseded by ADR-0003. The behavior below is historical and is not an available compatibility mode.**

Within one Update File section, resolve every hunk against the same pre-edit source. After anchor affinity and selector dominance produce each hunk's strongest candidate set, resolve consecutive ambiguity groups jointly: discard overlapping assignments, use the nearest uniquely resolved hunks as optional boundaries, and select an assignment by authored source order only when exactly one ordered assignment remains. This increases safe application success without letting implicit position override stronger match evidence or silently choose among unresolved alternatives.

## Consequences

- A uniquely dominant match applies even when its source position differs from authored hunk order.
- Dominated candidates are never revived by conflict avoidance or source order.
- Source order compares complete, non-overlapping source spans and permits adjacency.
- One valid non-overlapping assignment succeeds regardless of order; with multiple valid assignments, exactly one source-ordered assignment succeeds, while zero or multiple ordered assignments remain ambiguous.
- No conflict-free assignment reports conflicting hunks. Candidate truncation cannot establish uniqueness.
- Resolution is atomic per Update File section. Later hunks cannot match earlier hunk output; dependent edits require a later Update File section.
- The tie-breaker is always enabled for every selector type. Source-order resolution is recorded in `orderResolution` audit details without a warning, and unresolved groups receive group-level diagnostics.
