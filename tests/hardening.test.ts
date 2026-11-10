import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";
process.env.RATE_LIMIT_MAX = "3";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.BODY_LIMIT = "1kb";
process.env.MAX_HOST_LENGTH = "20";
process.env.MAX_GUEST_NAME_LENGTH = "10";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-hardening-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("rate limiter returns 429 with Retry-After once the window is exhausted", async () => {
  for (let i = 0; i < 3; i++) {
    const ok = await request(app).get("/availability/nobody");
    assert.equal(ok.status, 200);
  }

  const limited = await request(app).get("/availability/nobody");
  assert.equal(limited.status, 429);
  assert.ok(limited.headers["retry-after"]);
});

test("health checks bypass the rate limiter", async () => {
  for (let i = 0; i < 4; i++) {
    await request(app).get("/availability/nobody");
  }
  const health = await request(app).get("/healthz");
  assert.equal(health.status, 200);
});

test("rejects an over-long host", async () => {
  const r = await request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "x".repeat(21), start_at: at(1) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /host/);
});

test("rejects an over-long guest name", async () => {
  const slot = await request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "alice", start_at: at(1) });

  const r = await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_name: "y".repeat(11), guest_email: "bob@example.com" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /guest_name/);
});

test("rejects a request body over the configured limit", async () => {
  const r = await request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "alice", start_at: at(1), padding: "x".repeat(2000) });
  assert.equal(r.status, 413);
});
