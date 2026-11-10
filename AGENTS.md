# Working in this repo

A TypeScript booking service (Express 5 + SQLite) with a dependency-free browser UI.

## Commands

```bash
npm install
npm run dev        # start at http://127.0.0.1:8080
npm test           # run the test suite
npm run typecheck  # tsc --noEmit
npm run loadtest   # two-process mixed-load harness
npm run backup -- <destination.db>
```

## Conventions

- Keep changes covered by tests; run `npm test` and `npm run typecheck` before finishing.
- Prefer the existing patterns: pure validation helpers, a thin route layer, services for
  transactions/outbox, and small focused modules.
- Never log credentials or guest PII; use the structured logger's redaction.
- Host-facing endpoints require API-key authentication.
- Timestamps are stored and returned as ISO 8601 UTC.
