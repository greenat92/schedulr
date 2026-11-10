import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";

const { getDb, initDb, dbPath } = await import("../src/db.js");
const { backupDatabase } = await import("../src/backup.js");

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-backup-"));
  process.env.DB_PATH = join(dir, "test.db");
});

test("online backup produces a readable copy with the same data", async () => {
  initDb();
  getDb()
    .prepare("INSERT INTO slots (host, start_at, duration_minutes) VALUES (?, ?, ?)")
    .run("alice", new Date(Date.now() + 3600_000).toISOString(), 30);

  const destination = join(mkdtempSync(join(tmpdir(), "schedulr-backup-out-")), "copy.db");
  const pages = await backupDatabase(dbPath(), destination);
  assert.ok(pages >= 0);

  const copy = new DatabaseSync(destination);
  try {
    const row = copy.prepare("SELECT COUNT(*) AS n FROM slots").get() as { n: number };
    assert.equal(row.n, 1);
  } finally {
    copy.close();
  }
});
