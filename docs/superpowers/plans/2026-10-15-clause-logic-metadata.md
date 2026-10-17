# 条款逻辑元数据与三值求值实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep all changes local; no commit, push, deploy, or external model request.

**Goal:** Add versioned all/any/condition metadata for safely interpretable standard clauses and evaluate every required node with source-backed true/false/unknown semantics.

**Architecture:** Store explicit clause trees in a versioned local JSON file and synthesize an opaque full-clause node for unannotated clauses. The catalog loader validates and attaches trees; the assessment prompt receives them; the result normalizer binds model conditions to tree groups, recomputes truth from validated fact IDs and quotations, and promotes a grade only when the root is true.

**Tech Stack:** Existing Node.js ESM, built-in JSON, existing Node test runner, Vite and Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-15-clause-logic-metadata-design.md`

## Global Constraints

- Preserve official clause text and IDs exactly; metadata describes logic without rewriting the standard.
- Operators are `all`, `any`, and `condition`; clause evaluation is three-valued.
- Only explicit, traceable facts can make a condition true; only explicit exclusion or a verified numeric predicate can make it false; unresolved cases are unknown.
- Opaque clauses always evaluate unknown; source-text overlap alone never makes an opaque clause pass.
- Preserve the two-stage analysis and existing provider/result condition schemas; no new dependency, database, framework, or provenance graph.
- Modify one metadata data file plus the catalog, assessment, results and facts production modules; extend the existing two test files and the UI-only fixture helper. The facts change preserves the number/unit evidence needed by typed predicates.
- Keep model requests offline; do not commit, push, or deploy.

---

### Task 1: Add catalog logic metadata and loader validation

**Files:**
- Create: `gemini/data/clause-logic-v1.json`
- Modify: `gemini/lib/catalog.js`
- Test: `tests/stability.test.js`

**Interfaces:**
- `catalogs[type].clauses[]` gains `conditionLogic: { annotation, logic }`.
- `applyClauseLogicMetadata(rawCatalogs, logicMetadata)` validates metadata keys and recursive nodes, then returns catalogs whose clauses carry `conditionLogic`. An explicit condition leaf has exactly one of `factMatch: { field, values }` or `predicate: { field, operator, value, unit }`.
- A clause without a metadata entry receives `{ annotation: 'opaque', logic: { op: 'condition', sourceText: clause.text, conditionText: clause.text } }`; the evaluator checks the clause annotation first and returns unknown for opaque clauses.

- [x] **Step 1: Write failing loader tests** for one explicit all/any tree with valid field/value matchers, opaque default for a clause without a key, rejection of an unknown clause key, rejection of a source span absent from official text, and rejection of an explicit leaf without a fact matcher or predicate. Call `applyClauseLogicMetadata` with synthetic catalogs so each invalid case is independently testable.
- [x] **Step 2: Run targeted tests and verify they fail** with missing `conditionLogic`/validator behavior.
- [x] **Step 3: Add the version-1 JSON metadata and loader validator.** Explicitly annotate only clauses whose leaves map to existing canonical fact fields/values or typed numeric predicates. Include safe OR/AND regression clauses where all leaves have such mappings; keep `5.2.2.a` and `5.2.2.c` opaque unless their shared-area qualifier has a complete, testable fact mapping. All other unmatched catalog clauses remain opaque.
- [x] **Step 4: Run targeted loader tests** and verify the new catalog tests pass (2/2).
- [x] **Step 5: Run an offline catalog scan** over all 847 clauses. It counted 268 clauses with literal `或/或者`, 10 with `之一/任一/任意/任选/任择/其一`, 277 with either marker set, and currently 4 explicit versus 843 opaque entries. The earlier broad 276 count is not exactly reproducible from these rules; use the exact marker definitions in future reports.

### Task 2: Implement recursive three-valued logic evaluation

**Files:**
- Modify: `gemini/lib/results.js`
- Test: `tests/results.test.js`

**Interfaces:**
- `evaluateConditionLogic(node, facts)` returns `{ met: true | false | null, evidence, factIds }`.
- `all` is false if any child is false, true if every child is true, otherwise null.
- `any` is true if any child is true, false if every child is false, otherwise null.
- A condition leaf returns true only for a reliable linked fact with the exact configured field/value match and a traceable quotation; false only for linked excluded evidence or a validated predicate below threshold; otherwise null. A fact with `field: 'other'` or only a matching quote cannot satisfy an explicit leaf.

- [x] **Step 1: Add failing unit cases** for all/any truth tables, nested OR+AND, one false plus one unknown, wrong field, wrong canonical value, unrelated evidence, exclusion, and an unknown numeric quantity.
- [x] **Step 2: Run the targeted cases** and confirm they failed because `evaluateConditionLogic` was not exported.
- [x] **Step 3: Implement the evaluator in `results.js`** using the tree supplied by the catalog. Do not parse free-form clause text or infer field/value mappings in the evaluator.
- [x] **Step 4: Run `node --test tests/results.test.js`**; 32/32 pass including the truth-table cases.

### Task 3: Bind model conditions to metadata and gate grades

**Files:**
- Modify: `gemini/lib/results.js`, `gemini/lib/assessment.js`
- Test: `tests/results.test.js`, `tests/stability.test.js`

**Interfaces:**
- Assessment catalog context includes each selected clause's `conditionLogic`.
- The assessment instruction requires one condition entry per required top-level metadata group and direct fact IDs for its support.
- Result normalization binds each proposed condition to an exact metadata group. Missing, duplicated, ambiguous, or unsupported groups evaluate to null.
- Existing `references[].conditions[]` fields stay unchanged. If a tree has more than 12 display groups, emit one root summary condition while retaining the complete internal evaluation.

- [x] **Step 1: Add failing integration regressions** for mixed OR+AND criteria, false OR branch plus unknown branch, explicitly excluded all-OR branches, omitted required group, fabricated group text, and a source-backed unrelated fact that must not produce a grade.
- [x] **Step 2: Run the targeted cases and verify failure** on current flat-condition handling.
- [x] **Step 3: Update assessment rules and result normalization.** Recompute `met`, `relation`, `status`, and `grade` from the metadata tree; model booleans cannot override the tree. Keep global conflicts at `needs_review` and preserve existing evidence checks.
- [x] **Step 4: Add an assessment-call regression** confirming the metadata appears in the provided catalog context while `providerResultSchema` and the two-stage call order remain unchanged.
- [x] **Step 5: Run `node --test tests/results.test.js tests/stability.test.js`**; 92/92 integration and normalization tests pass.

### Task 4: Validate metadata coverage and run the full local suite

**Files:**
- Modify: `gemini/data/clause-logic-v1.json` only where a source span or tree was shown invalid by tests.
- Verify: `gemini/lib/catalog.js`, `gemini/lib/assessment.js`, `gemini/lib/results.js`, `tests/results.test.js`, `tests/stability.test.js`.

- [x] **Step 1: Add a catalog-wide structural assertion** that every explicit node validates against its official clause and has a field/value matcher or typed predicate; every other clause has an opaque fallback.
- [x] **Step 2: Re-run representative threshold, semicolon, shared-qualifier, and historical-rib regressions.** Unknown required predicates must not pass; explicit low counts remain false; historical facts cannot satisfy current counts.
- [x] **Step 3: Run full verification:** `npm test` 112/112; `npm run build` succeeded; `npm run test:browser -- --workers=1` 28/28; `git -c core.whitespace=cr-at-eol diff --check` produced no errors.
- [x] **Step 4: Audit `git status --short` and the diff.** Test outputs and redacted samples are ignored and untracked; no credential match was found in changed code/data/docs. The UI-only fixture helper is additionally modified to avoid using production grade normalization in browser mocks.
- [x] **Step 5: Update the existing local `analysis-report.md`, `progress.md`, and `task_plan.md`** with coverage counts, final test outputs, and limitations. No new general report or medical/legal accuracy claim was added.

## Completion Conditions

- Every annotated clause tree passes static source-span validation; every unannotated clause is opaque and cannot pass from a partial model condition.
- Three-valued nested logic is tested independently and through final grade normalization.
- A grade survives only when all required logical conditions are true, no conflict blocks the result, and every supporting source fact is traceable.
- Full local test/build/browser verification passes. Existing saved model results remain offline inputs; no new external calls are made.
- All changes remain local and uncommitted.
