# Select Patch

Select Patch applies concise, uniquely targeted text changes while preserving explicit author constraints.

## Language

**Line anchor**:
A hard constraint limiting where a hunk may match. It is never an approximate location or permission to search beyond the stated boundary.
_Avoid_: Proximity hint, approximate anchor

**Out-of-bound match**:
A unique hunk match that exists outside its line anchor. It may be reported for diagnosis but is never applied.
_Avoid_: Retry match, fallback match
