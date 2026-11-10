import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface IdempotencyRecord {
  requestHash: string;
  status: number;
  body: string;
}

/** Deterministic fingerprint of the booking payload, used to detect key reuse. */
export function hashBookingRequest(slotId: number, guestName: string, guestEmail: string): string {
  return createHash("sha256")
    .update(`${slotId}\u0000${guestName}\u0000${guestEmail}`)
    .digest("hex");
}

export function findIdempotencyRecord(
  db: DatabaseSync,
  key: string,
): IdempotencyRecord | undefined {
  const row = db
    .prepare(
      "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ?",
    )
    .get(key) as
    | { request_hash: string; response_status: number; response_body: string }
    | undefined;

  if (row === undefined) return undefined;
  return { requestHash: row.request_hash, status: row.response_status, body: row.response_body };
}

/** Returns false when the key already exists (i.e. a concurrent request won). */
export function storeIdempotencyResponse(
  db: DatabaseSync,
  key: string,
  requestHash: string,
  status: number,
  body: string,
): boolean {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO idempotency_keys (key, request_hash, response_status, response_body) VALUES (?, ?, ?, ?)",
    )
    .run(key, requestHash, status, body);
  return Number(info.changes) === 1;
}
