# Use hierarchical resolution for tolerant line anchors

Tolerant line anchors resolve candidates by affinity—contained, then overlapping, then outside—and consider a weaker class only when every stronger class has no candidates. Existing selector dominance and ambiguity rules apply within the active class. This preserves anchors as the primary safety signal while recovering uniquely identifiable stale-anchor matches, and avoids the cost and unrelated candidate-cap failures of global whole-file ranking.
