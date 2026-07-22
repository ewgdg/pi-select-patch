# Select Patch

Select Patch applies concise text changes using selectors, explicit constraints, and authored forward order.

## Language

**Line anchor**:
A declared target interval used to resolve a hunk according to the active anchor mode.
_Avoid_: Line hint

**Strict anchor mode**:
A resolution policy that permits only matches fully contained by the line anchor.

**Tolerant anchor mode**:
A hierarchical resolution policy that selects the best non-empty anchor-affinity class, then applies selector dominance within that class. It considers a weaker affinity class only when every stronger class has no candidates.

**Anchor affinity**:
A candidate's relationship to its line anchor, ordered as contained, overlapping, then outside.

**Tolerated match**:
A hunk match applied by tolerant anchor mode despite not being fully contained by its line anchor. Its use is reported as a warning.
_Avoid_: Retry match, fallback match, out-of-bound match

**Whole-section resolution**:
Resolution of every hunk in an Update File section against the same pre-edit source before any section edit applies.

**Forward-chain resolution**:
A resolution policy that selects the earliest complete, source-ordered, non-overlapping assignment from cursor-relative strongest candidate sets. Authored hunk order forms a forward search chain over the pre-edit source.

**Chain cursor**:
The earliest source position eligible for the next authored hunk. It starts at the beginning of an Update File section and advances past each selected locator or hunk span.

**Forward span order**:
The lexicographic ordering of complete hunk spans by start line and then end line, compared in authored hunk order. It defines the earliest complete forward chain.

**Forward eligibility**:
A candidate is forward eligible when its complete source span starts at or after the current chain cursor. Anchor affinity and selector dominance compare only forward-eligible candidates.

**Inline locator**:
Text authored on a hunk header that advances forward-chain search without modifying or reserving the matched source line.

**Locator hunk**:
A context-only hunk that advances forward-chain search without producing an edit. A locator hunk must be followed by a mutating hunk in the same Update File section.

**Strongest candidate set**:
The hunk candidates remaining after forward eligibility, anchor affinity, and selector dominance are applied at one chain cursor. Backtracking to a different cursor recomputes this set.

**Authored application order**:
The order in which a selected forward chain materializes, matching hunk order in the patch.

**Hunk conflict**:
An overlap between source spans assigned to mutating hunks in the same Update File section. A complete forward chain cannot contain a hunk conflict.

**Replace tool**:
A top-level editing operation for substituting literal text in one file without expressing complete replacement lines.

**Literal replacement match**:
A case-sensitive match over decoded text after line endings are canonicalized. It performs no trimming, dedenting, fuzzy matching, or Unicode normalization; the file BOM is outside the searchable text.

**Replacement occurrence**:
A left-to-right, non-overlapping literal replacement match. Searching resumes after the full matched text.
