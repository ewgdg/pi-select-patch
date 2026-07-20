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

**Replace tool**:
A top-level editing operation for substituting literal text in one file without expressing complete replacement lines.

**Literal replacement match**:
A case-sensitive match over decoded text after line endings are canonicalized. It performs no trimming, dedenting, fuzzy matching, or Unicode normalization; the file BOM is outside the searchable text.

**Replacement occurrence**:
A left-to-right, non-overlapping literal replacement match. Searching resumes after the full matched text.
