# Use hierarchical resolution for tolerant line anchors

Tolerant line anchors resolve forward-eligible candidates by affinity—contained, then overlapping, then outside—and consider a weaker class only when every stronger class has no candidates. Selector dominance and forward-chain resolution apply within the active class. This preserves anchors as the primary safety signal while recovering stale-anchor matches, and avoids the cost and unrelated candidate-cap failures of global whole-file ranking.
