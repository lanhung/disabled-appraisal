# Stable Fact-Based Appraisal Design

## Goal

Make repeated assessment requests stable and traceable by separating objective fact extraction from injury/disability assessment, while preserving the two static sites and the existing Gemini-compatible proxy interface.

## Design

The existing pages will send the original text and image bytes as typed request data, along with assessment type and the page's local standard excerpt/version. The proxy validates the request and image format, computes SHA-256 fingerprints, then calls a versioned fact-extraction prompt using the configured Kimi text or vision model. The server validates every fact, source excerpt, certainty label, conflict, and missing-information list before producing a snapshot. A small deterministic rib parser protects laterality, anatomical ordinal numbers, fracture count, negation, and uncertainty from common model confusion.

Assessment runs under a separate versioned prompt and receives only the validated fact snapshot plus the supplied standard excerpt and its version. It must return the legacy result fields and explicit evidence fact IDs, status, and verified/unverified clause references. The server validates those fields and rejects unsupported clause claims. If evidence is insufficient or output invalid, the API reports a controlled error and the existing UI may show its visibly labeled demo fallback.

Two bounded in-memory caches store only validated fact snapshots and non-demo assessment results. Their keys include relevant prompt, schema, model, assessment type, image/content, and standard versions. In-flight promises deduplicate same-key concurrency. No medical inputs are persisted or written to logs. A force-reanalysis request bypasses completed cache entries while still sharing an existing in-flight request.

The API retains `POST /api/analyze`, Gemini-style `contents`, and `candidates[0].content.parts[0].text`. New clients send explicit raw input metadata; legacy callers remain accepted with conservative type inference. Updated front ends show a collapsible fact section and preserve old localStorage records while recording result provenance for new items. Existing condensed standard databases remain usable for reference search but are clearly identified as incomplete; no legal text is synthesized.

## Interfaces and versions

- `FACT_EXTRACTION_PROMPT`: `fact-extraction-v1`
- `INJURY_ASSESSMENT_PROMPT`: `injury-assessment-v2`
- `DISABILITY_ASSESSMENT_PROMPT`: `disability-assessment-v2`
- Fact schema: `fact-schema-1.0`
- Cache format: `assessment-cache-1`
- Standard versions identify the exact in-page excerpt, not a claim that it is the full official standard.

## Failure and privacy behavior

Input, MIME, upstream, timeout, invalid JSON, missing fields, and schema errors produce bounded non-sensitive API errors and never enter result caches. JSON Mode is used where supported by the configured endpoint; local validators remain authoritative. Temperature is configurable and defaults to zero, but no claim of model determinism is made. Simulation remains available and is always labeled `演示结果` with `source_type: demo`.

## Verification

Use the built-in Node test runner with injected mock model calls for parser/schema cases, repeated and concurrent calls, version/key separation, API errors, and image validation. Exercise 20 sequential identical requests and 20 parallel identical requests. Validate both page scripts and run repository diff checks. Mock tests establish software behavior and request stability only; they do not establish medical fact extraction accuracy or legal correctness.
