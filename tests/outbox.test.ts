import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";

process.env.EMAIL_LATENCY_MS = "10";
process.env.EMAIL_FAILURE_RATE = "0";
process.env.HOST_API_KEYS = "alice:alice-key,bob:bob-key";
process.env.LOG_LEVEL = "error";

const { createApp, initDb } = await import("../src/app.js");
const { processOutboxOnce } = await import("../src/outbox.js");

let app: ReturnType<typeof createApp>;

function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

interface OutboxRow {
  id: number;
  status: string;
  attempts: number;
  next_attempt_at: string;
  to_email: string;
}

function readOutbox(): OutboxRow[] {
  const db = new DatabaseSync(process.env.DB_PATH as string);
  try {
    return db
      .prepare("SELECT id, status, attempts, next_attempt_at, to_email FROM email_outbox ORDER BY id")
      .all() as unknown as OutboxRow[];
  } finally {
    db.close();
  }
}

function forceDue(id: number): void {
  const db = new DatabaseSync(process.env.DB_PATH as string);
  try {
    db.prepare("UPDATE email_outbox SET next_attempt_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      id,
    );
  } finally {
    db.close();
  }
}

async function bookFirstSlot(): Promise<number> {
  const slot = await request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "alice", start_at: at(1) });
  const booking = await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_name: "Bob", guest_email: "bob@example.com" });
  return booking.body.booking_id;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-outbox-"));
  process.env.DB_PATH = join(dir, "test.db");
  process.env.EMAIL_LATENCY_MS = "10";
  process.env.EMAIL_FAILURE_RATE = "0";
  initDb();
  app = createApp();
});

test("booking persists an outbox row instead of sending inline", async () => {
  await bookFirstSlot();
  const rows = readOutbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.to_email, "bob@example.com");
});

test("worker delivers a pending email and marks it sent", async () => {
  await bookFirstSlot();
  const delivered = await processOutboxOnce();
  assert.equal(delivered, 1);
  assert.equal(readOutbox()[0]!.status, "sent");

  const metricsResponse = await request(app).get("/metrics");
  assert.match(metricsResponse.text, /email_deliveries_total\{result="success"\}/);
});

test("failed delivery is retried with backoff rather than dropped", async () => {
  await bookFirstSlot();
  process.env.EMAIL_FAILURE_RATE = "1";
  process.env.EMAIL_LATENCY_MS = "0";

  const delivered = await processOutboxOnce();
  assert.equal(delivered, 0);

  const row = readOutbox()[0]!;
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), "next attempt should be in the future");

  // Provider recovers; once the retry is due, the email goes out.
  process.env.EMAIL_FAILURE_RATE = "0";
  forceDue(row.id);
  const retried = await processOutboxOnce();
  assert.equal(retried, 1);
  assert.equal(readOutbox()[0]!.status, "sent");
});

test("outbox endpoint requires authentication", async () => {
  const response = await request(app).get("/outbox");
  assert.equal(response.status, 401);
});

test("outbox endpoint shows the host's queued email, then its delivery", async () => {
  await bookFirstSlot();

  const queued = await request(app).get("/outbox").set("Authorization", "Bearer alice-key");
  assert.equal(queued.status, 200);
  assert.equal(queued.body.rows.length, 1);
  assert.equal(queued.body.rows[0].status, "pending");
  assert.equal(queued.body.stats.pending, 1);

  await processOutboxOnce();

  const delivered = await request(app).get("/outbox").set("Authorization", "Bearer alice-key");
  assert.equal(delivered.body.rows[0].status, "sent");
  assert.equal(delivered.body.stats.sent, 1);
  assert.equal(delivered.body.stats.pending, 0);
});

test("outbox endpoint is scoped to the authenticated host", async () => {
  await bookFirstSlot();
  const response = await request(app).get("/outbox").set("Authorization", "Bearer bob-key");
  assert.equal(response.status, 200);
  assert.equal(response.body.rows.length, 0);
});
