# Scoping: migrating from SQLite to Postgres

Status: **not implemented** — this is the design/rollout plan for the P3
architectural item. Everything else in P0–P2 is in place and measured.

## Why

SQLite has carried the service well (single host, ~6k req/s in the two-process
load test), but it is a **single-writer** store and the data lives on one host.
That blocks: horizontal scaling beyond processes sharing one file, read replicas,
multi-AZ HA, and zero-downtime failover. Postgres also gives us `FOR UPDATE SKIP
LOCKED`, proper `timestamptz`, and mature backup/PITR tooling.

Keep SQLite for **local development and tests**; target Postgres in production.

## Current coupling points to isolate first

| Area | File | Postgres impact |
|---|---|---|
| Connection/lifecycle | `src/db.ts` | `DatabaseSync` (sync) → async `pg` pool; drop PRAGMAs |
| Schema/history | `src/migrations.ts` | rewrite DDL dialect; use a migration runner |
| Booking transaction | `src/booking.ts` | sync statements + `BEGIN IMMEDIATE` → async client + `BEGIN` |
| Outbox claim/retry | `src/outbox.ts` | conditional UPDATE → `SELECT … FOR UPDATE SKIP LOCKED` |
| Idempotency | `src/idempotency.ts` | `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` |
| Routes | `src/app.ts` | handlers become `async`; query via repositories |
| Tests | `tests/*` | keep SQLite path, or run against ephemeral Postgres |

Today SQL is embedded in handlers. The migration is the forcing function to
introduce a thin **repository layer** (SRP) so dialect stays out of routes.

## Target architecture

```
HTTP (async handlers)
   └─ services: booking, outbox, idempotency
        └─ repositories (interface)
             ├─ SqliteAdapter  (dev/tests, sync→Promise wrappers)
             └─ PostgresAdapter (pg Pool, transactions, FOR UPDATE SKIP LOCKED)
```

- `withTransaction(pool, fn)` helper checks out a client, `BEGIN`/`COMMIT`/
  `ROLLBACK`, and releases it — replaces the ad-hoc `BEGIN IMMEDIATE` blocks.
- Prepared statements become parameterized queries through the pool.
- Timestamps become `timestamptz`; `start_at` stays canonical UTC.
- `booked` becomes `boolean`; `AUTOINCREMENT` becomes `GENERATED ALWAYS AS IDENTITY`.
- Keep unique indexes: `slots(host, start_at)`, `bookings(slot_id)`,
  `idempotency_keys(key)`.

## Concurrency semantics (must be preserved)

- **One booking per slot:** `UPDATE slots SET booked = true WHERE id = $1 AND booked = false`
  and check `rowCount`; unique index on `bookings.slot_id` remains the backstop.
- **Idempotency:** `INSERT … ON CONFLICT (key) DO NOTHING`; on conflict, read and
  replay the stored response; 422 on hash mismatch.
- **Outbox:** `BEGIN; SELECT id … WHERE status='pending' AND next_attempt_at<=now()
  ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED; update to 'sending'; COMMIT;` then
  deliver outside the transaction. Same retry/backoff/dead-letter policy.
- **Availability:** optional read replica for `GET /availability` (accept bounded
  staleness) with the existing in-process cache in front.

## Migration / rollout plan

1. **Refactor without behavior change** on SQLite: introduce repository
   interfaces + async service functions; keep all tests green.
2. **Add the Postgres adapter** behind a factory (`DATABASE_URL` selects it).
3. **Schema migrations**: port `migrations.ts` to a Postgres migration runner
   (e.g. `node-pg-migrate`), preserving the same version history.
4. **Backfill**: one-time copy `sqlite → postgres` (bookings, slots, outbox,
   idempotency, hosts). Verify row counts and integrity.
5. **Dual-run in staging** with the load harness pointed at Postgres; assert the
   same invariants (no double bookings, outbox drained, idempotent replays).
6. **Cutover**: short maintenance window (or dual-write + backfill if
   zero-downtime is required), switch `DATABASE_URL`, verify `/readyz`.
7. **Keep SQLite** for developer ergonomics and fast tests; add a Postgres CI job
   for integration coverage.

## Operational changes

- Connection pool sizing (start `max=10`, tune by p95/DB wait time).
- Backups: managed PITR instead of file copies; keep the runbook's verify steps.
- Observability: add pool stats (`pg_pool_total/idle/waiting`) and query latency.
- Rate limiting and cache should move to a shared store (e.g. Redis) once more
  than one instance is serving, since both are currently per-process.

## Effort / risk

- Repository extraction: ~1–2 days, low risk (tests guard behavior).
- Postgres adapter + migrations: ~1–2 days.
- Backfill + staging dual-run: ~1 day.
- Main risks: async refactor of transaction boundaries; timestamp/timezone
  handling; outbox claim semantics. Each is covered by the existing invariants
  and the load harness.
