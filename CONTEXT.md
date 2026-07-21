# Select Patch

Select Patch applies concise, uniquely targeted text changes while preserving explicit author constraints.

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

**Source-order tie-breaker**:
A secondary resolution rule over the strongest candidate set that prefers assignments whose complete source spans follow authored hunk order. One span follows another when the earlier span ends before the later span begins; adjacency is allowed. It resolves a tie only when exactly one source-ordered assignment remains; zero or multiple source-ordered assignments remain ambiguous. It does not override a uniquely dominant match.

**Ambiguity group**:
One or more consecutive hunks whose strongest match evidence leaves tied candidates. The group is resolved jointly using authored source order and the nearest uniquely resolved hunks before and after it as optional positional boundaries.

**Strongest candidate set**:
The hunk candidates remaining after anchor affinity and selector dominance are applied. Conflict filtering and source-order tie-breaking operate only on this set, regardless of selector type.

**Authored application order**:
The order in which resolved hunks from an Update File section apply, matching their order in the patch regardless of their source positions.

**Hunk conflict**:
An overlap between the complete source spans assigned to two hunks in the same Update File section. A hunk conflict invalidates the section regardless of selector dominance or authored order.

**Replace tool**:
A top-level editing operation for substituting literal text in one file without expressing complete replacement lines.

**Literal replacement match**:
A case-sensitive match over decoded text after line endings are canonicalized. It performs no trimming, dedenting, fuzzy matching, or Unicode normalization; the file BOM is outside the searchable text.

**Replacement occurrence**:
A left-to-right, non-overlapping literal replacement match. Searching resumes after the full matched text.
