import type { Request } from "express";
import type { LengthLimits } from "./config.js";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedSlot {
  host?: string;
  startAt: string;
  duration: number;
}

export function parseSlot(body: unknown, limits: LengthLimits): Validated<ParsedSlot> {
  const input = (body ?? {}) as Record<string, unknown>;

  let host: string | undefined;
  if (input.host !== undefined) {
    if (typeof input.host !== "string" || input.host.trim() === "") {
      return { ok: false, error: "host must be a non-empty string" };
    }
    host = input.host.trim();
    if (host.length > limits.host) {
      return { ok: false, error: `host must be at most ${limits.host} characters` };
    }
  }

  if (typeof input.start_at !== "string" || input.start_at.trim() === "") {
    return { ok: false, error: "start_at is required" };
  }
  if (input.start_at.length > limits.startAt) {
    return { ok: false, error: `start_at must be at most ${limits.startAt} characters` };
  }

  const startDate = new Date(input.start_at);
  if (Number.isNaN(startDate.getTime())) {
    return { ok: false, error: "start_at must be a valid ISO 8601 datetime" };
  }
  if (startDate.getTime() <= Date.now()) {
    return { ok: false, error: "start_at must be in the future" };
  }

  const duration = Number(input.duration_minutes ?? 30);
  if (!Number.isInteger(duration) || duration <= 0) {
    return { ok: false, error: "duration_minutes must be a positive integer" };
  }

  return { ok: true, value: { host, startAt: startDate.toISOString(), duration } };
}

export interface ParsedBooking {
  slotId: number;
  guestName: string;
  guestEmail: string;
}

export function parseBooking(body: unknown, limits: LengthLimits): Validated<ParsedBooking> {
  const input = (body ?? {}) as Record<string, unknown>;

  const slotId = Number(input.slot_id);
  if (!Number.isInteger(slotId) || slotId <= 0) {
    return { ok: false, error: "slot_id must be a positive integer" };
  }

  if (typeof input.guest_name !== "string" || input.guest_name.trim() === "") {
    return { ok: false, error: "guest_name is required" };
  }
  const guestName = input.guest_name.trim();
  if (guestName.length > limits.guestName) {
    return { ok: false, error: `guest_name must be at most ${limits.guestName} characters` };
  }

  if (typeof input.guest_email !== "string") {
    return { ok: false, error: "guest_email must be a valid email" };
  }
  const guestEmail = input.guest_email.trim();
  if (guestEmail.length > limits.guestEmail) {
    return { ok: false, error: `guest_email must be at most ${limits.guestEmail} characters` };
  }
  if (!EMAIL_PATTERN.test(guestEmail)) {
    return { ok: false, error: "guest_email must be a valid email" };
  }

  return { ok: true, value: { slotId, guestName, guestEmail } };
}

/** Optional `Idempotency-Key` header, bounded to keep storage in check. */
export function parseIdempotencyKey(req: Request, maxLength: number): Validated<string | undefined> {
  const raw = req.get("idempotency-key");
  if (raw === undefined) return { ok: true, value: undefined };

  const key = raw.trim();
  if (key === "") return { ok: true, value: undefined };
  if (key.length > maxLength) {
    return { ok: false, error: `Idempotency-Key must be at most ${maxLength} characters` };
  }
  return { ok: true, value: key };
}
