import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";

process.env.EMAIL_LATENCY_MS = "10";
process.env.EMAIL_FAILURE_RATE = "0";
process.env.HOST_API_KEYS = "alice:alice-key,bob:bob-key,carol:carol-key,dave:dave-key,dup:dup-key";
process.env.LOG_LEVEL = "error";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

/** ISO timestamp `hours` in the future, so tests never depend on the wall clock. */
function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function bearer(host: string): string {
  return `Bearer ${host}-key`;
}

function createSlot(host: string, startAt: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/slots")
    .set("Authorization", bearer(host))
    .send({ host, start_at: startAt, ...extra });
}

function getBookings(host: string, query = "") {
  return request(app).get(`/bookings/${host}${query}`).set("Authorization", bearer(host));
}

/** Insert a slot directly, bypassing the API (used to model rows created before validation existed). */
function insertRawSlot(host: string, startAt: string): number {
  const db = new DatabaseSync(process.env.DB_PATH as string);
  try {
    const info = db
      .prepare("INSERT INTO slots (host, start_at, duration_minutes, booked) VALUES (?, ?, ?, 0)")
      .run(host, startAt, 30);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-issues-"));
  process.env.DB_PATH = join(dir, "test.db");
  process.env.EMAIL_LATENCY_MS = "10";
  process.env.EMAIL_FAILURE_RATE = "0";
  initDb();
  app = createApp();
});

// ---------------------------------------------------------------------------
// Input validation: bad requests must be 4xx, never a 500 / silent success.
// ---------------------------------------------------------------------------

test("rejects unauthenticated slot creation (401, not 500)", async () => {
  const r = await request(app).post("/slots").send({ host: "alice", start_at: at(1) });
  assert.equal(r.status, 401);
  assert.ok(r.body.error);
});

test("rejects creating slots for another host (403)", async () => {
  const r = await request(app)
    .post("/slots")
    .set("Authorization", bearer("alice"))
    .send({ host: "bob", start_at: at(1) });
  assert.equal(r.status, 403);
});

test("rejects a slot without a start_at (400, not 500)", async () => {
  const r = await request(app)
    .post("/slots")
    .set("Authorization", bearer("alice"))
    .send({ host: "alice" });
  assert.equal(r.status, 400);
});

test("rejects a slot with an unparseable start_at", async () => {
  const r = await createSlot("alice", "not-a-date");
  assert.equal(r.status, 400);
});

test("rejects a slot with a non-positive duration", async () => {
  const zero = await createSlot("alice", at(1), { duration_minutes: 0 });
  const negative = await createSlot("alice", at(2), { duration_minutes: -15 });
  assert.equal(zero.status, 400);
  assert.equal(negative.status, 400);
});

test("rejects a slot in the past", async () => {
  const r = await createSlot("alice", "2020-01-01T00:00:00.000Z");
  assert.equal(r.status, 400);
});

test("rejects a duplicate slot for the same host and time", async () => {
  const start = at(1);
  const first = await createSlot("alice", start);
  const second = await createSlot("alice", start);
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
});

test("rejects a booking with a non-numeric slot_id", async () => {
  const r = await request(app)
    .post("/book")
    .send({ slot_id: "abc", guest_name: "Bob", guest_email: "bob@example.com" });
  assert.equal(r.status, 400);
});

test("rejects a booking without a guest_email and does not persist it", async () => {
  const slot = await createSlot("alice", at(1));
  const r = await request(app).post("/book").send({ slot_id: slot.body.id, guest_name: "Bob" });
  assert.equal(r.status, 400);

  const bookings = await getBookings("alice");
  assert.equal(bookings.body.length, 0);
});

test("rejects a booking with a malformed guest_email", async () => {
  const slot = await createSlot("alice", at(1));
  const r = await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_name: "Bob", guest_email: "not-an-email" });
  assert.equal(r.status, 400);
});

test("rejects a booking without a guest_name", async () => {
  const slot = await createSlot("alice", at(1));
  const r = await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_email: "bob@example.com" });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Past slots: excluded from availability and refused at booking time.
// ---------------------------------------------------------------------------

test("excludes past slots from availability", async () => {
  insertRawSlot("alice", "2020-01-01T00:00:00.000Z");
  await createSlot("alice", at(1));

  const r = await request(app).get("/availability/alice");
  assert.equal(r.body.length, 1);
  assert.ok(r.body.every((s: { start_at: string }) => s.start_at > "2021-01-01"));
});

test("refuses to book a past slot", async () => {
  const slotId = insertRawSlot("alice", "2020-01-01T00:00:00.000Z");
  const r = await request(app)
    .post("/book")
    .send({ slot_id: slotId, guest_name: "Bob", guest_email: "bob@example.com" });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Concurrency: a slot can only ever be booked once.
// ---------------------------------------------------------------------------

test("concurrent bookings yield exactly one success", async () => {
  const slot = await createSlot("alice", at(1));

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post("/book")
        .send({ slot_id: slot.body.id, guest_name: `Guest ${i}`, guest_email: `g${i}@example.com` }),
    ),
  );

  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 4);

  const bookings = await getBookings("alice");
  assert.equal(bookings.body.length, 1);
});

// ---------------------------------------------------------------------------
// Email must never sit on the request's critical path, and must not lose a booking.
// ---------------------------------------------------------------------------

test("booking response is not blocked by email latency", async () => {
  const slot = await createSlot("alice", at(1));

  process.env.EMAIL_LATENCY_MS = "500";
  const started = Date.now();
  const r = await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_name: "Bob", guest_email: "bob@example.com" });
  const elapsed = Date.now() - started;
  process.env.EMAIL_LATENCY_MS = "10";

  assert.equal(r.status, 201);
  assert.ok(elapsed < 250, `booking took ${elapsed}ms; email delivery must not block the response`);
});

test("booking still succeeds when the email provider fails", async () => {
  const slot = await createSlot("alice", at(1));

  process.env.EMAIL_FAILURE_RATE = "1";
  const r = await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_name: "Bob", guest_email: "bob@example.com" });
  process.env.EMAIL_FAILURE_RATE = "0";

  assert.equal(r.status, 201);
  const bookings = await getBookings("alice");
  assert.equal(bookings.body.length, 1);
});

// ---------------------------------------------------------------------------
// Error handling: malformed bodies become clean 4xx JSON, no stack leak.
// ---------------------------------------------------------------------------

test("malformed JSON body returns a 400 JSON error", async () => {
  const r = await request(app)
    .post("/slots")
    .set("Content-Type", "application/json")
    .send("{ this is not json");
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, "string");
});

// ---------------------------------------------------------------------------
// Privacy: bookings are only visible to the authenticated host.
// ---------------------------------------------------------------------------

test("bookings are not readable without authentication (401)", async () => {
  const r = await request(app).get("/bookings/alice");
  assert.equal(r.status, 401);
});

test("a host cannot read another host's bookings (403)", async () => {
  const r = await request(app).get("/bookings/alice").set("Authorization", bearer("bob"));
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Pagination: unbounded lists are a load hazard.
// ---------------------------------------------------------------------------

test("availability honours limit", async () => {
  for (let i = 1; i <= 3; i++) {
    await createSlot("alice", at(i));
  }
  const r = await request(app).get("/availability/alice?limit=2");
  assert.equal(r.body.length, 2);
});

test("bookings honours limit", async () => {
  for (let i = 1; i <= 2; i++) {
    const slot = await createSlot("alice", at(i));
    await request(app)
      .post("/book")
      .send({ slot_id: slot.body.id, guest_name: `Guest ${i}`, guest_email: `g${i}@example.com` });
  }
  const r = await getBookings("alice", "?limit=1");
  assert.equal(r.body.length, 1);
});
