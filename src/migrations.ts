import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * Ordered, append-only schema history. Never edit an applied migration; add a
 * new one instead. The first migration is written idempotently so databases
 * created before this framework existed adopt it safely.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up(db: DatabaseSync): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS slots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          host TEXT NOT NULL,
          start_at TEXT NOT NULL,
          duration_minutes INTEGER NOT NULL,
          booked INTEGER DEFAULT 0
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slot_id INTEGER NOT NULL,
          guest_name TEXT NOT NULL,
          guest_email TEXT NOT NULL,
          booked_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS hosts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          api_key TEXT NOT NULL UNIQUE
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          booking_id INTEGER NOT NULL,
          to_email TEXT NOT NULL,
          host TEXT NOT NULL,
          start_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          locked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          response_status INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_slots_host ON slots(host)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_host_start ON slots(host, start_at)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot_unique ON bookings(slot_id)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox(status, next_attempt_at)",
      );
    },
  },
];

/**
 * Applies pending migrations. Each runs in its own IMMEDIATE transaction so
 * concurrent processes cannot double-apply, and a failed migration rolls back.
 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const applied = db
        .prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
        .get(migration.version);

      if (applied !== undefined) {
        db.exec("COMMIT");
        continue;
      }

      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name,
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures
      }
      throw error;
    }
  }
}
