import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";

const { createApp, initDb } = await import("../src/app.js");
const { redact } = await import("../src/logger.js");

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-logging-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("redact masks credentials and PII recursively", () => {
  const result = redact({
    authorization: "Bearer secret",
    guest_email: "bob@example.com",
    nested: { api_key: "abc", name: "Bob" },
  }) as Record<string, unknown>;

  assert.equal(result.authorization, "[redacted]");
  assert.equal(result.guest_email, "[redacted]");
  assert.deepEqual(result.nested, { api_key: "[redacted]", name: "Bob" });
});

test("responses carry a generated request id", async () => {
  const response = await request(app).get("/healthz");
  const requestId = response.headers["x-request-id"];
  assert.equal(typeof requestId, "string");
  assert.ok(requestId.length > 0);
});

test("inbound request id is echoed back", async () => {
  const response = await request(app).get("/healthz").set("x-request-id", "trace-123");
  assert.equal(response.headers["x-request-id"], "trace-123");
});
