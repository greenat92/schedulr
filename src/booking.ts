import type { DatabaseSync } from "node:sqlite";
import { isUniqueViolation, withBusyRetry } from "./db.js";
import {
  findIdempotencyRecord,
  hashBookingRequest,
  storeIdempotencyResponse,
} from "./idempotency.js";

interface SlotRow {
  id: number;
  host: string;
  start_at: string;
  duration_minutes: number;
  booked: number;
}

export interface BookingInput {
  slotId: number;
  guestName: string;
  guestEmail: string;
  idempotencyKey?: string;
}

export type BookingResult =
  | { type: "created"; bookingId: number; host: string }
  | { type: "replayed"; status: number; body: unknown }
  | { type: "conflict" }
  | { type: "not_found" }
  | { type: "past" }
  | { type: "idempotency_conflict" };

function lookupReplay(
  db: DatabaseSync,
  key: string,
  requestHash: string,
): BookingResult | undefined {
  const record = findIdempotencyRecord(db, key);
  if (record === undefined) return undefined;
  if (record.requestHash !== requestHash) return { type: "idempotency_conflict" };

  try {
    return { type: "replayed", status: record.status, body: JSON.parse(record.body) };
  } catch {
    return { type: "idempotency_conflict" };
  }
}

/**
 * Books a slot atomically: claim the slot, write the booking, enqueue the email,
 * and record the idempotency key. Either all of it commits or none of it does.
 * Transient lock contention is retried at the outer boundary.
 */
export function bookSlot(db: DatabaseSync, input: BookingInput): BookingResult {
  return withBusyRetry(() => attemptBookSlot(db, input));
}

function attemptBookSlot(db: DatabaseSync, input: BookingInput): BookingResult {
  const requestHash = input.idempotencyKey
    ? hashBookingRequest(input.slotId, input.guestName, input.guestEmail)
    : undefined;

  if (input.idempotencyKey !== undefined && requestHash !== undefined) {
    const replay = lookupReplay(db, input.idempotencyKey, requestHash);
    if (replay !== undefined) return replay;
  }

  const slot = db.prepare("SELECT * FROM slots WHERE id = ?").get(input.slotId) as
    | SlotRow
    | undefined;
  if (slot === undefined) return { type: "not_found" };
  if (slot.booked) return { type: "conflict" };
  if (new Date(slot.start_at).getTime() <= Date.now()) return { type: "past" };

  db.exec("BEGIN IMMEDIATE");
  try {
    const claim = db
      .prepare("UPDATE slots SET booked = 1 WHERE id = ? AND booked = 0")
      .run(input.slotId);
    if (Number(claim.changes) === 0) {
      db.exec("ROLLBACK");
      return { type: "conflict" };
    }

    const info = db
      .prepare("INSERT INTO bookings (slot_id, guest_name, guest_email) VALUES (?, ?, ?)")
      .run(input.slotId, input.guestName, input.guestEmail);
    const bookingId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO email_outbox (booking_id, to_email, host, start_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(bookingId, input.guestEmail, slot.host, slot.start_at, new Date().toISOString());

    if (input.idempotencyKey !== undefined && requestHash !== undefined) {
      const stored = storeIdempotencyResponse(
        db,
        input.idempotencyKey,
        requestHash,
        201,
        JSON.stringify({ booking_id: bookingId }),
      );
      if (!stored) {
        // A concurrent request already recorded this key; discard our attempt
        // and return the response that won.
        db.exec("ROLLBACK");
        return lookupReplay(db, input.idempotencyKey, requestHash) ?? { type: "conflict" };
      }
    }

    db.exec("COMMIT");
    return { type: "created", bookingId, host: slot.host };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failures
    }

    if (isUniqueViolation(error)) {
      if (input.idempotencyKey !== undefined && requestHash !== undefined) {
        const replay = lookupReplay(db, input.idempotencyKey, requestHash);
        if (replay !== undefined) return replay;
      }
      return { type: "conflict" };
    }
    throw error;
  }
}
