# Replace Tool

## Goal

Implement GitHub issue #10: add a profile-independent top-level `replace` tool for exact literal substitution while preserving the existing selector `edit` contract.

## Intention

Keep Replace as a deep, isolated module. Its registered tool is the public seam; literal matching, newline/BOM handling, direct whole-file publication, error construction, and rendering remain internal. Reuse only stable shared boundaries: Pi's file mutation queue, existing text-file validation, unified diff generation, and bounded diff coloring.

## Scope & Constraints

- Exact schema: `file_path`, `old_string`, `new_string`, optional `replace_all: false`; no aliases or additional properties.
- Semantic validation precedes filesystem access.
- Match canonicalized LF text exactly, case-sensitively, without Unicode normalization or fuzzy behavior.
- Preserve BOM; choose output newline from the first existing newline sequence; normalize mixed output.
- Queue the complete read-modify-write window by the existing real target.
- Publish through a direct whole-file write seam, not the atomic selector-edit writer.
- Check cancellation before queue work and immediately before publication; keep the queue until publication settles; successful publication wins over in-flight cancellation.
- Return only the exact compact receipt plus `{ diff, occurrenceCount }` details.
- Keep `edit` behavior and metadata unchanged.
- Preserve the user's existing uncommitted `CONTEXT.md` change and do not include it in the implementation commit.

## Work Plan

1. Add registered-tool seam tests for schema/metadata and core unique replacement.
2. Add vertical behavior tests for occurrence modes, literal semantics, validation, BOM/newlines, file failures, details, and errors.
3. Add deterministic publication/cancellation/queue tests through the narrow publication adapter.
4. Add Replace rendering tests for streaming/progress, bounded previews, errors, and bounded colorized diffs.
5. Register/activate Replace beside `edit` for all profiles; update integration/regression assertions.
6. Update README to distinguish literal Replace from selector Edit.
7. Run targeted tests and typecheck throughout; run full validation once complete.
8. Review the completed diff against repository standards and issue #10, fix findings, then commit.

## Validation

- `npm run typecheck`
- targeted `vitest run` files during each slice
- `npm run validate` at the end
- two-axis code review against the pre-work commit and issue #10

## Progress

- [x] Issue and repository contract inspected.
- [x] Pi extension, custom tool rendering, and mutation queue documentation inspected.
- [x] Tests written red-first at the registered Replace tool seam.
- [x] Core tool behavior implemented.
- [x] Publication/cancellation/queue behavior implemented.
- [x] Rendering and extension integration implemented.
- [x] Documentation updated.
- [x] Full validation and two-axis review completed with no remaining findings.
- [x] Implementation and review fixes committed on the current branch.

## Surprises & Discoveries

- Pi's mutation queue resolves existing paths before invoking the queued callback. Resolution failures therefore must be classified before queue registration so raw `EACCES`, `ELOOP`, or similar errors cannot escape the Replace error contract.
- The tool update callback is a stable observable point after planning and before publication. Tests use it to abort deterministically at the final cancellation check without exposing an additional implementation hook.

## Decisions

- The TDD seam is pre-agreed by issue #10: the registered Replace tool interface, with a narrow publication adapter only for deterministic failure/cancellation tests.
- Production publication will use a direct `writeFile` of the complete serialized result.
- Existing shared selector-edit atomic publication will not be reused.
- Shared text-file validation is reused with a bounded caller-facing error path, while publication remains Replace-specific and direct.

## Outcomes & Retrospective

- Added the profile-independent `replace` tool beside selector `edit`, including exact schema/metadata, literal occurrence semantics, BOM/newline handling, compact receipts, full diff details, queue integration, direct publication, cancellation behavior, and bounded TUI rendering.
- Added registered-tool, filesystem, queue, cancellation, rendering, extension-registration, and live-session coverage while preserving existing selector-edit regression tests.
- Final validation passed: 17 test files and 295 tests, plus TypeScript typechecking.
- Final Standards and Spec reviews reported no remaining actionable findings.
