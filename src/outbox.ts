import { getDb } from "./db.js";
import { sendBookingConfirmation } from "./email.js";
import { logger } from "./logger.js";
import { metrics } from "./metrics.js";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
// A row stuck in `sending` longer than this is assumed to belong to a worker
// that died and is reclaimed.
const STALE_LOCK_MS = 60_000;

interface OutboxRow {
  id: number;
  booking_id: number;
  to_email: string;
  host: string;
  start_at: string;
  attempts: number;
}

export interface OutboxOptions {
  batchSize?: number;
  concurrency?: number;
}

/**
 * Processes one batch of pending outbox rows. Safe to run from multiple
 * processes: each row is claimed with a conditional UPDATE before sending.
 * Returns the number of rows successfully delivered.
 */
export async function processOutboxOnce(options: OutboxOptions = {}): Promise<number> {
  const batchSize = options.batchSize ?? 20;
  const concurrency = options.concurrency ?? 5;
  const db = getDb();
  let delivered = 0;

  const now = Date.now();
  db.prepare(
    "UPDATE email_outbox SET status = 'pending', locked_at = NULL WHERE status = 'sending' AND locked_at < ?",
  ).run(new Date(now - STALE_LOCK_MS).toISOString());

  const rows = db
    .prepare(
      `SELECT id, booking_id, to_email, host, start_at, attempts
       FROM email_outbox
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(new Date(now).toISOString(), batchSize) as unknown as OutboxRow[];

  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const chunk = rows.slice(offset, offset + concurrency);
    await Promise.all(
      chunk.map(async (row) => {
        const claim = db
          .prepare(
            "UPDATE email_outbox SET status = 'sending', locked_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(new Date().toISOString(), row.id);
        if (Number(claim.changes) === 0) return;

        try {
          await sendBookingConfirmation(row.to_email, row.host, row.start_at);
          db.prepare(
            "UPDATE email_outbox SET status = 'sent', locked_at = NULL, last_error = NULL WHERE id = ?",
          ).run(row.id);
          metrics.inc("email_deliveries_total", { result: "success" });
          delivered += 1;
        } catch (error) {
          const attempts = row.attempts + 1;
          const message = (error as Error).message;
          metrics.inc("email_deliveries_total", { result: "failure" });

          if (attempts >= MAX_ATTEMPTS) {
            db.prepare(
              "UPDATE email_outbox SET status = 'failed', attempts = ?, locked_at = NULL, last_error = ? WHERE id = ?",
            ).run(attempts, message, row.id);
            metrics.inc("email_deliveries_total", { result: "dead_letter" });
          } else {
            const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
            db.prepare(
              "UPDATE email_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, locked_at = NULL, last_error = ? WHERE id = ?",
            ).run(attempts, new Date(Date.now() + backoff).toISOString(), message, row.id);
          }
        }
      }),
    );
  }

  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status IN ('pending', 'sending')")
    .get() as { n: number };
  metrics.gauge("email_outbox_pending", pending.n);
  metrics.inc("email_worker_cycles_total");
  metrics.gauge("email_worker_last_run_timestamp_seconds", Date.now() / 1000);

  return delivered;
}

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

/** Starts the background poller. Returns a stop function. */
export function startEmailWorker(pollIntervalMs = 500): () => void {
  if (timer) {
    return () => stopEmailWorker();
  }

  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void processOutboxOnce()
      .catch((error) => {
        logger.error("email worker cycle failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, pollIntervalMs);
  timer.unref();

  return () => stopEmailWorker();
}

export function stopEmailWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
