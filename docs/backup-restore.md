# Backup & restore runbook

The database is a single SQLite file (`DB_PATH`, default `schedulr.db`) running
in WAL mode. Backups use SQLite's online backup API, so they are consistent even
while the service is serving traffic.

## Taking a backup

```bash
npm run backup -- /path/to/backups/schedulr-$(date +%Y%m%dT%H%M%S).db
```

- Source defaults to `DB_PATH` (or `schedulr.db`).
- Destination defaults to `<source>.backup-<timestamp>`.
- Output is JSON: source, destination, and pages copied.
- Schedule this (cron / managed cron) at least hourly, retain daily/weekly
  copies, and store them off the host.

Verify a backup by opening it and running integrity checks:

```bash
sqlite3 /path/to/backups/schedulr-....db "PRAGMA integrity_check;"
sqlite3 /path/to/backups/schedulr-....db "SELECT COUNT(*) FROM bookings;"
```

## Restoring

Restore is a stop-the-world operation.

1. **Stop the service** (SIGTERM). Wait for it to exit so the DB is closed.
2. (If you have a live DB) flush WAL so the `.db` file is self-contained:
   `sqlite3 schedulr.db "PRAGMA wal_checkpoint(TRUNCATE);"`
3. **Move the current DB aside** (do not delete until the restore is verified):
   `mv schedulr.db schedulr.db.broken-$(date +%Y%m%dT%H%M%S)`
4. **Copy the chosen backup** into place: `cp <backup> schedulr.db`
5. **Remove stale WAL sidecars** for the restored file:
   `rm -f schedulr.db-wal schedulr.db-shm`
6. **Start the service.** Migrations run automatically on boot and are
   idempotent, so the restored file is brought up to the current schema.
7. **Verify**: `GET /readyz` returns ready, then spot-check
   `GET /availability/<host>` and `GET /bookings/<host>` (with the host's API key).

## Notes

- Bookings and their confirmation emails are written atomically; the
  `email_outbox` is part of the same database, so a restore also restores any
  not-yet-sent email for retry. Idempotency keys are restored too, which is what
  you want for client retry safety.
- A restore loses any writes committed after the backup was taken. Keep the
  backup interval aligned with your acceptable RPO.
- Test the restore procedure against a copy periodically; an unverified backup
  is not a backup.
