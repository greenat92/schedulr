# Build log — prompts and outcomes

A chronological record of the prompts used to build this project and what each produced.
Kept as documentation of the working process; it is not part of the runtime.

## 1. Understand the baseline

> Read the README and analyze the code. Explain the main flow. Do not write code or submit
> anything without approval.

**Outcome:** Mapped the request flow (`POST /slots` → `GET /availability` → `POST /book` →
`GET /bookings`), the per-request SQLite connection, the blocking synchronous email send, and an
inventory of bugs and production-readiness gaps (race conditions, missing validation, PII leak,
non-atomic writes, no observability).

## 2. Tests first, then fixes

> Add tests for all the issues found, then fix them and verify.

**Outcome:** Added regression tests for validation, past/duplicate slots, double-booking races,
email latency/failures, malformed JSON, and pagination. Confirmed the tests failed against the
baseline, then fixed the issues. Added validation, atomic slot claiming, fire-and-forget email,
error middleware, and pagination.

## 3. Production-readiness review

> Examine scalability, latency, availability, observability, and concurrent calls. List all items
> and prioritize.

**Outcome:** Produced a prioritized roadmap across those dimensions, ordered as data integrity →
security → operability → performance → scale.

## 4. Roadmap execution (P0 → P3)

> Execute the roadmap, one tier at a time.

**Outcome:**

- **P0** — transaction around booking + email enqueue, `UNIQUE(bookings.slot_id)`, host API-key
  auth (no public PII), durable email outbox with retry/backoff.
- **P1** — config validation, structured logging with request IDs + redaction, rate limiting,
  request timeouts, field/body limits, idempotency keys, graceful shutdown, global handlers.
- **P2** — shared SQLite connection, WAL + `synchronous=NORMAL`, `SQLITE_BUSY` retry, availability
  cache. Measured: ~2.4k → ~6.3k req/s, p99 ~74ms → ~10ms, per-request connections → 0.
- **P3** — keyset pagination, versioned migrations, gzip + keep-alive, online backup tooling,
  Postgres migration plan.

## 5. Measurements and load testing

> Add measurements and a repeatable mixed-load test, including two app processes.

**Outcome:** Prometheus metrics (RED, DB, email, cache, event-loop lag), `/healthz`, `/readyz`,
`/metrics`, and a two-process load harness with invariants (no double bookings, no stranded
slots, drained outbox, zero 5xx) and latency/throughput reporting.

## 6. Frontend

> Build a UI for the app and run the whole project locally. Skip Postgres for now.

**Outcome:** A dependency-free single-page UI for creating slots, browsing availability, booking,
and viewing bookings, served by Express from `public/`.

## 7. Scenario lab

> Implement frontend scenarios that simulate the issues we solved and the production-readiness
> work.

**Outcome:** `/lab.html` runs live checks for validation, duplicate/past slots, concurrent
double-booking, idempotency, auth/PII, pagination, health, request IDs, compression, cache,
shared connections, the email outbox, metrics, and rate limiting — with pass/fail details.

## 8. Email worker dashboard

> Add a UI to visualize the email worker, and let it generate 100.

**Outcome:** Host-scoped `GET /outbox`, worker metrics (cycles, last run, pending), and
`/outbox.html` with live status transitions, auto-refresh, and batch generation of up to 100
bookings.

## 9. Rate-limit behavior

> When we reach the rate limit, why does the worker stop processing email?

**Outcome:** It doesn't — the worker is server-side. The dashboard's polling shared the per-IP
rate-limit bucket, starving bookings and freezing the UI. Fixed with per-route buckets, static
asset exemptions, a `Retry-After`-aware backoff banner, and friendly `429` toasts. Verified the
worker keeps delivering while the API is limited.

## 10. API documentation

> Is there any API docs? Add them.

**Outcome:** `docs/api.md`, an OpenAPI 3.0.3 spec (`docs/openapi.yaml`) served at
`/openapi.json`, and a browsable `/api-docs` page.

## 11. Clean history and publishing

> Commit the changes, clean the README, rename the repo, publish it with `gh`, and record the
> prompts.

**Outcome:** A curated commit history, a project-focused README, removal of legacy tooling
references, this build log, and publication to GitHub.
