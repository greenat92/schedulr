import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";

const { getDb, initDb } = await import("../src/db.js");

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-migrations-"));
  process.env.DB_PATH = join(dir, "test.db");
});

test("initDb applies the initial migration exactly once", () => {
  initDb();
  initDb();

  const rows = getDb()
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string }[];

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.version, 1);
});

test("the migrated schema is queryable", () => {
  initDb();
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((table) => table.name);

  assert.ok(names.includes("slots"));
  assert.ok(names.includes("bookings"));
  assert.ok(names.includes("email_outbox"));
  assert.ok(names.includes("idempotency_keys"));
});
