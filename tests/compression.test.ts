import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";
process.env.COMPRESSION_THRESHOLD_BYTES = "0";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-compression-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("compresses responses when the client accepts gzip", async () => {
  const response = await request(app).get("/availability/nobody").set("Accept-Encoding", "gzip");
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.match(response.headers["vary"], /Accept-Encoding/i);
});

test("leaves responses uncompressed when gzip is not accepted", async () => {
  const response = await request(app)
    .get("/availability/nobody")
    .set("Accept-Encoding", "identity");
  assert.equal(response.headers["content-encoding"], undefined);
});
