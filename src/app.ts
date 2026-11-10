import express from "express";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authenticateHost } from "./auth.js";
import { bookSlot } from "./booking.js";
import { TtlCache } from "./cache.js";
import { gzipResponses } from "./compression.js";
import { loadConfig, type AppConfig } from "./config.js";
import { getDb, isUniqueViolation, withBusyRetry } from "./db.js";
import { errorHandler, notFoundHandler, requestContext, requestTimeout, sendError } from "./http.js";
import { configureLogger, logger } from "./logger.js";
import { metrics, renderMetrics } from "./metrics.js";
import { encodeCursor, parsePageRequest, type Cursor } from "./pagination.js";
import { createRateLimiter } from "./rateLimit.js";
import { parseBooking, parseIdempotencyKey, parseSlot } from "./validation.js";

export { initDb } from "./db.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const openApiPath = fileURLToPath(new URL("../docs/openapi.yaml", import.meta.url));
const apiDocsPath = fileURLToPath(new URL("../public/api-docs.html", import.meta.url));

// Only API routes are rate limited. Static assets and page navigations are not,
// so an exhausted bucket can never turn the app shell into an error page.
const RATE_LIMITED_PREFIXES = [
  "/slots",
  "/book",
  "/availability",
  "/bookings",
  "/outbox",
  "/config",
];

function isRateLimitedPath(path: string): boolean {
  return RATE_LIMITED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

// Bucket per route group, so an endpoint (e.g. dashboard polling) cannot starve
// unrelated endpoints for the same IP.
function rateLimitBucket(path: string): string {
  return RATE_LIMITED_PREFIXES.find(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  ) ?? path;
}

interface CachedPage {
  items: unknown[];
  nextCursor?: string;
}

interface PageRow {
  id: number;
  start_at: string;
}

/** Trims a `limit + 1` result set into a page and its continuation cursor. */
function toPage(rows: PageRow[], limit: number): CachedPage {
  if (rows.length <= limit) {
    return { items: rows };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return { items, nextCursor: encodeCursor(last.start_at, last.id) };
}

function sendPage(res: Response, page: CachedPage): Response {
  if (page.nextCursor !== undefined) {
    res.setHeader("x-next-cursor", page.nextCursor);
  }
  return res.json(page.items);
}

function queryAvailability(
  host: string,
  limit: number,
  offset: number,
  cursor: Cursor | undefined,
): PageRow[] {
  const db = getDb();
  const now = new Date().toISOString();
  const base = "SELECT * FROM slots WHERE host = ? AND booked = 0 AND start_at > ?";
  const fetch = limit + 1;

  if (cursor !== undefined) {
    return db
      .prepare(
        `${base} AND (start_at > ? OR (start_at = ? AND id > ?)) ORDER BY start_at, id LIMIT ?`,
      )
      .all(host, now, cursor.startAt, cursor.startAt, cursor.id, fetch) as unknown as PageRow[];
  }
  return db
    .prepare(`${base} ORDER BY start_at, id LIMIT ? OFFSET ?`)
    .all(host, now, fetch, offset) as unknown as PageRow[];
}

function queryBookings(
  db: ReturnType<typeof getDb>,
  host: string,
  limit: number,
  offset: number,
  cursor: Cursor | undefined,
): PageRow[] {
  const base = `SELECT bookings.*, slots.start_at, slots.duration_minutes
                FROM bookings JOIN slots ON bookings.slot_id = slots.id
                WHERE slots.host = ?`;
  const fetch = limit + 1;

  if (cursor !== undefined) {
    return db
      .prepare(
        `${base} AND (slots.start_at > ? OR (slots.start_at = ? AND bookings.id > ?)) ORDER BY slots.start_at, bookings.id LIMIT ?`,
      )
      .all(host, cursor.startAt, cursor.startAt, cursor.id, fetch) as unknown as PageRow[];
  }
  return db
    .prepare(`${base} ORDER BY slots.start_at, bookings.id LIMIT ? OFFSET ?`)
    .all(host, fetch, offset) as unknown as PageRow[];
}

/** Metrics + structured access logging for every request (except /metrics). */
function observeRequests() {
  return (req: Request, res: Response, next: () => void) => {
    if (req.path === "/metrics") {
      return next();
    }

    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route?.path ?? req.path;
      metrics.inc("http_requests_total", {
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      metrics.observe("http_request_duration_seconds", durationMs / 1000, {
        method: req.method,
        route,
      });
      logger.info("request", {
        requestId: res.locals.requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });
    return next();
  };
}

export function createApp(config: AppConfig = loadConfig()): express.Express {
  configureLogger(config.logLevel);

  const app = express();
  const availabilityCache = new TtlCache<CachedPage>(config.availabilityCacheTtlMs);
  const availabilityKeyPrefix = (host: string) => `${host}\u0000`;

  app.use(requestContext());
  app.use(observeRequests());
  app.use(requestTimeout(config.requestTimeoutMs));
  app.use(
    createRateLimiter({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      key: (req) => `${req.ip ?? "unknown"}:${rateLimitBucket(req.path)}`,
      skip: (req) => !isRateLimitedPath(req.path),
    }),
  );
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(gzipResponses(config.compressionThresholdBytes));
  app.use(express.static(publicDir));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.get("/config", (_req, res) => {
    const row = getDb()
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    // Non-secret operational configuration, useful for the UI and ops tooling.
    return res.json({
      schemaVersion: row.version ?? 0,
      rateLimit: config.rateLimit,
      availabilityCacheTtlMs: config.availabilityCacheTtlMs,
      compressionThresholdBytes: config.compressionThresholdBytes,
      requestTimeoutMs: config.requestTimeoutMs,
      bodyLimit: config.bodyLimit,
      limits: config.limits,
    });
  });

  app.get("/readyz", (_req, res) => {
    try {
      getDb().prepare("SELECT 1").get();
      return res.json({ status: "ready" });
    } catch {
      return sendError(res, 503, "unavailable");
    }
  });

  app.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return res.send(renderMetrics());
  });

  app.get("/openapi.json", (_req, res) => {
    try {
      // Stored as JSON-compatible YAML so no YAML parser is needed.
      const spec = readFileSync(openApiPath, "utf8");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(spec);
    } catch {
      return sendError(res, 404, "openapi spec not found");
    }
  });

  app.get("/api-docs", (_req, res) => res.sendFile(apiDocsPath));

  app.post("/slots", (req, res) => {
    const db = getDb();
    const auth = authenticateHost(db, req, config.limits.apiKey);
    if (!auth.ok) {
      metrics.inc("slots_created_total", { result: "unauthorized" });
      return sendError(res, auth.status, auth.error);
    }

    const parsed = parseSlot(req.body, config.limits);
    if (!parsed.ok) {
      metrics.inc("slots_created_total", { result: "invalid" });
      return sendError(res, 400, parsed.error);
    }

    if (parsed.value.host !== undefined && parsed.value.host !== auth.host) {
      metrics.inc("slots_created_total", { result: "forbidden" });
      return sendError(res, 403, "cannot create slots for another host");
    }

    try {
      const info = withBusyRetry(() =>
        db
          .prepare("INSERT INTO slots (host, start_at, duration_minutes) VALUES (?, ?, ?)")
          .run(auth.host, parsed.value.startAt, parsed.value.duration),
      );
      metrics.inc("slots_created_total", { result: "success" });
      availabilityCache.invalidatePrefix(availabilityKeyPrefix(auth.host));
      return res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        metrics.inc("slots_created_total", { result: "duplicate" });
        return sendError(res, 409, "slot already exists");
      }
      throw error;
    }
  });

  app.get("/availability/:host", (req, res) => {
    const page = parsePageRequest(req.query);
    if (!page.ok) {
      return sendError(res, 400, page.error);
    }

    const { limit, offset, cursor } = page.value;
    const cursorKey = cursor === undefined ? "" : `${cursor.startAt}\u0000${cursor.id}`;
    const cacheKey = `${availabilityKeyPrefix(req.params.host)}${limit}\u0000${offset}\u0000${cursorKey}`;

    const cached = availabilityCache.get(cacheKey);
    if (cached !== undefined) {
      metrics.inc("availability_cache_total", { result: "hit" });
      return sendPage(res, cached);
    }

    metrics.inc("availability_cache_total", { result: "miss" });
    const rows = queryAvailability(req.params.host, limit, offset, cursor);
    const cachedPage = toPage(rows, limit);
    availabilityCache.set(cacheKey, cachedPage);
    return sendPage(res, cachedPage);
  });

  app.post("/book", (req, res) => {
    const parsed = parseBooking(req.body, config.limits);
    if (!parsed.ok) {
      metrics.inc("bookings_total", { result: "invalid" });
      return sendError(res, 400, parsed.error);
    }

    const key = parseIdempotencyKey(req, config.limits.idempotencyKey);
    if (!key.ok) {
      metrics.inc("bookings_total", { result: "invalid" });
      return sendError(res, 400, key.error);
    }

    const result = bookSlot(getDb(), {
      slotId: parsed.value.slotId,
      guestName: parsed.value.guestName,
      guestEmail: parsed.value.guestEmail,
      idempotencyKey: key.value,
    });

    switch (result.type) {
      case "created":
        metrics.inc("bookings_total", { result: "success" });
        availabilityCache.invalidatePrefix(availabilityKeyPrefix(result.host));
        return res.status(201).json({ booking_id: result.bookingId });
      case "replayed":
        metrics.inc("bookings_total", { result: "replayed" });
        metrics.inc("idempotent_replays_total");
        return res.status(result.status).json(result.body);
      case "conflict":
        metrics.inc("bookings_total", { result: "conflict" });
        return sendError(res, 409, "slot already booked");
      case "not_found":
        metrics.inc("bookings_total", { result: "not_found" });
        return sendError(res, 404, "slot not found");
      case "past":
        metrics.inc("bookings_total", { result: "past" });
        return sendError(res, 400, "slot is in the past");
      case "idempotency_conflict":
        metrics.inc("bookings_total", { result: "idempotency_conflict" });
        return sendError(res, 422, "idempotency key reused with a different request");
    }
  });

  // Host-scoped view of the email outbox so the worker can be observed live.
  app.get("/outbox", (req, res) => {
    const db = getDb();
    const auth = authenticateHost(db, req, config.limits.apiKey);
    if (!auth.ok) {
      return sendError(res, auth.status, auth.error);
    }

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const base = `SELECT id, booking_id, to_email, host, status, attempts,
                         next_attempt_at, locked_at, last_error, created_at
                  FROM email_outbox
                  WHERE host = ?`;
    const rows = (
      status !== undefined
        ? db.prepare(`${base} AND status = ? ORDER BY id DESC LIMIT ?`).all(auth.host, status, limit)
        : db.prepare(`${base} ORDER BY id DESC LIMIT ?`).all(auth.host, limit)
    ) as unknown[];

    const statsRows = db
      .prepare("SELECT status, COUNT(*) AS n FROM email_outbox WHERE host = ? GROUP BY status")
      .all(auth.host) as { status: string; n: number }[];
    const stats: Record<string, number> = { pending: 0, sending: 0, sent: 0, failed: 0 };
    for (const row of statsRows) stats[row.status] = row.n;

    return res.json({ rows, stats });
  });

  app.get("/bookings/:host", (req, res) => {
    const db = getDb();
    const auth = authenticateHost(db, req, config.limits.apiKey);
    if (!auth.ok) {
      return sendError(res, auth.status, auth.error);
    }
    if (auth.host !== req.params.host) {
      return sendError(res, 403, "cannot view another host's bookings");
    }

    const page = parsePageRequest(req.query);
    if (!page.ok) {
      return sendError(res, 400, page.error);
    }

    const rows = queryBookings(db, req.params.host, page.value.limit, page.value.offset, page.value.cursor);
    return sendPage(res, toPage(rows, page.value.limit));
  });

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
