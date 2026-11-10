# schedulr API reference

Base URL (local): `http://127.0.0.1:8080`

Machine-readable spec: [`docs/openapi.yaml`](./openapi.yaml) (JSON-compatible YAML),
served at **`/openapi.json`**. A browsable list is at **`/api-docs`**.

- **Host endpoints** require an API key: `Authorization: Bearer <key>` (or `X-Api-Key: <key>`).
- **Guest endpoints** are public.
- Bodies and responses are JSON unless noted.

## Authentication

Hosts are seeded from the `HOST_API_KEYS` environment variable:

```bash
HOST_API_KEYS="alice:alice-key,bob:bob-key" npm run dev
```

When `HOST_API_KEYS` is unset and `NODE_ENV !== "production"`, development keys are
seeded as `<host>-key` (e.g. `alice-key`).

```bash
curl -H "Authorization: Bearer alice-key" http://127.0.0.1:8080/bookings/alice
```

A host may only create slots for, or read bookings/outbox of, **itself** (`403` otherwise).

## Conventions

- Timestamps are ISO 8601 UTC (e.g. `2026-12-01T14:00:00.000Z`). `start_at` must be in the future.
- Every response includes **`X-Request-Id`** (echoed if supplied).
- Errors are `{ "error": "<message>" }` with a 4xx/5xx status.
- List endpoints page with `limit` / `offset`, or a keyset `cursor`. When more rows exist a
  **`X-Next-Cursor`** header is returned; pass it back as `?cursor=...`.
- Rate limited responses are `429` with a **`Retry-After`** header (seconds).
- Responses may be gzip-compressed (`Content-Encoding: gzip`) for larger payloads.

### Pagination example

```bash
curl "http://127.0.0.1:8080/availability/alice?limit=2" -D headers.txt
# read X-Next-Cursor from headers, then:
curl "http://127.0.0.1:8080/availability/alice?limit=2&cursor=<cursor>"
```

## Guest endpoints

### `GET /availability/{host}`

List a host's open (unbooked, future) slots, ordered by `start_at`.

Query: `limit` (1–500, default 100), `offset`, `cursor`.

```bash
curl "http://127.0.0.1:8080/availability/alice?limit=50"
```

`200` →

```json
[
  { "id": 1, "host": "alice", "start_at": "2026-12-01T14:00:00.000Z", "duration_minutes": 30, "booked": 0 }
]
```

### `POST /book`

Book an open slot. Optionally send `Idempotency-Key` to make retries safe.

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `slot_id` | integer | yes | |
| `guest_name` | string | yes | ≤ 200 chars |
| `guest_email` | string | yes | valid email, ≤ 254 chars |

```bash
curl -X POST http://127.0.0.1:8080/book \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-..." \
  -d '{"slot_id":1,"guest_name":"Bob","guest_email":"bob@example.com"}'
```

`201` → `{ "booking_id": 1 }`

- Replaying the same key + payload returns the original `booking_id`.
- Reusing a key with a different payload → `422`.
- Errors: `400` invalid input, `404` slot not found, `409` already booked/past, `429` rate limited.

## Host endpoints

All require `Authorization: Bearer <key>`.

### `POST /slots`

Create an availability slot for the authenticated host.

| Field | Type | Required | Notes |
|---|---|---|---|
| `host` | string | no | If provided, must equal the authenticated host |
| `start_at` | string (ISO 8601) | yes | Must be in the future |
| `duration_minutes` | integer | no | Default 30, > 0 |

```bash
curl -X POST http://127.0.0.1:8080/slots \
  -H "Authorization: Bearer alice-key" \
  -H "Content-Type: application/json" \
  -d '{"start_at":"2026-12-01T14:00:00.000Z","duration_minutes":30}'
```

`201` → `{ "id": 1 }`. Errors: `400` invalid, `401` no/invalid key, `403` other host, `409` duplicate slot.

### `GET /bookings/{host}`

List the host's bookings, ordered by slot start.

Query: `limit`, `offset`, `cursor`.

```bash
curl -H "Authorization: Bearer alice-key" \
  "http://127.0.0.1:8080/bookings/alice?limit=50"
```

`200` →

```json
[
  { "id": 1, "slot_id": 1, "guest_name": "Bob", "guest_email": "bob@example.com",
    "booked_at": "2026-11-10 12:20:26", "start_at": "2026-12-01T14:00:00.000Z", "duration_minutes": 30 }
]
```

Errors: `401` no/invalid key, `403` other host.

### `GET /outbox`

Inspect the host's email outbox (newest first) and per-status counts.

Query: `limit` (≤ 200, default 50), `status` (`pending|sending|sent|failed`).

```bash
curl -H "Authorization: Bearer alice-key" \
  "http://127.0.0.1:8080/outbox?limit=20&status=pending"
```

`200` →

```json
{
  "rows": [
    { "id": 1, "booking_id": 1, "to_email": "bob@example.com", "host": "alice",
      "status": "sent", "attempts": 0, "next_attempt_at": "2026-11-10T12:20:26.206Z",
      "locked_at": null, "last_error": null, "created_at": "2026-11-10 12:20:26" }
  ],
  "stats": { "pending": 0, "sending": 0, "sent": 1, "failed": 0 }
}
```

Errors: `401` no/invalid key.

## Email worker

Bookings write to `email_outbox` **in the same transaction** as the booking. A background
worker polls every 500 ms, claims rows (`pending → sending`), delivers, and marks them `sent`.
Failures retry with exponential backoff (1s → 60s, max 5 attempts → `failed`/dead-letter).
Rows stuck in `sending` for over 60s are reclaimed. The worker is independent of HTTP
rate limiting.

Relevant metrics: `email_deliveries_total{result}`, `email_outbox_pending`,
`email_worker_cycles_total`, `email_worker_last_run_timestamp_seconds`.

## Operations

| Endpoint | Description |
|---|---|
| `GET /healthz` | Liveness → `{ "status": "ok" }` |
| `GET /readyz` | Readiness (runs `SELECT 1`) → `200 { "status": "ready" }` or `503` |
| `GET /config` | Non-secret config: rate limit, cache TTL, compression threshold, limits, `schemaVersion` |
| `GET /metrics` | Prometheus metrics |
| `GET /openapi.json` | This API's OpenAPI spec |
| `GET /api-docs` | Browsable endpoint list |

## Rate limiting

Per client IP **and route group**, fixed window (default `1000` requests / `60s`).
Health, readiness, metrics, the API spec, static assets, and page navigations are exempt.
Exceeding the limit returns `429` with `Retry-After`.

```bash
RATE_LIMIT_MAX=10 RATE_LIMIT_WINDOW_MS=60000 npm run dev
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `DB_PATH` | `schedulr.db` | SQLite database file |
| `HOST_API_KEYS` | dev defaults | `name:key,name:key` host credentials |
| `EMAIL_LATENCY_MS` | `300` | Simulated email provider latency |
| `EMAIL_FAILURE_RATE` | `0.05` | Simulated email failure rate (0–1) |
| `RATE_LIMIT_MAX` | `1000` | Requests per window per IP+route |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `AVAILABILITY_CACHE_TTL_MS` | `2000` | Availability cache TTL (`0` disables) |
| `COMPRESSION_THRESHOLD_BYTES` | `1024` | Minimum body size to gzip |
| `REQUEST_TIMEOUT_MS` | `10000` | Request timeout |
| `BODY_LIMIT` | `16kb` | Max JSON body size |
| `MAX_*_LENGTH` | see `/config` | Field length caps |
| `LOG_LEVEL` | `info` | `debug|info|warn|error` |

## See also

- [UI and scenario lab](../README.md)
- [Backup & restore](./backup-restore.md)
- [Postgres migration plan](./postgres-migration.md)
