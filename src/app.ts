import express from "express";
import { DatabaseSync } from "node:sqlite";
import { sendBookingConfirmation } from "./email.js";

interface SlotRow {
  id: number;
  host: string;
  start_at: string;
  duration_minutes: number;
  booked: number;
}

function dbPath(): string {
  return process.env.DB_PATH ?? "schedulr.db";
}

function getDb(): DatabaseSync {
  return new DatabaseSync(dbPath());
}

export function initDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      start_at TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      booked INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      guest_email TEXT NOT NULL,
      booked_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.close();
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.post("/slots", (req, res) => {
    const host = req.body.host;
    const startAt = req.body.start_at;
    const duration = req.body.duration_minutes ?? 30;

    const db = getDb();
    const info = db
      .prepare("INSERT INTO slots (host, start_at, duration_minutes) VALUES (?, ?, ?)")
      .run(host, startAt, duration);
    db.close();
    res.status(201).json({ id: info.lastInsertRowid });
  });

  app.get("/availability/:host", (req, res) => {
    const db = getDb();
    const slots = db
      .prepare("SELECT * FROM slots WHERE host = ? AND booked = 0 ORDER BY start_at")
      .all(req.params.host);
    db.close();
    res.json(slots);
  });

  app.post("/book", (req, res) => {
    const slotId = req.body.slot_id;
    const guestName = req.body.guest_name;
    const guestEmail = req.body.guest_email;

    console.log(`Booking slot ${slotId} for ${guestName} <${guestEmail}>`);

    const db = getDb();
    const slot = db.prepare("SELECT * FROM slots WHERE id = ?").get(slotId) as SlotRow | undefined;

    if (!slot) {
      db.close();
      return res.status(404).json({ error: "slot not found" });
    }

    if (slot.booked) {
      db.close();
      return res.status(409).json({ error: "slot already booked" });
    }

    const info = db
      .prepare("INSERT INTO bookings (slot_id, guest_name, guest_email) VALUES (?, ?, ?)")
      .run(slotId, guestName, guestEmail);
    db.prepare("UPDATE slots SET booked = 1 WHERE id = ?").run(slotId);
    const bookingId = info.lastInsertRowid;
    db.close();

    try {
      sendBookingConfirmation(guestEmail, slot.host, slot.start_at);
    } catch (e) {
      console.error(`Email failed: ${(e as Error).message}`);
    }

    return res.status(201).json({ booking_id: bookingId });
  });

  app.get("/bookings/:host", (req, res) => {
    const db = getDb();
    const bookings = db
      .prepare(`
        SELECT bookings.*, slots.start_at, slots.duration_minutes
        FROM bookings JOIN slots ON bookings.slot_id = slots.id
        WHERE slots.host = ?
        ORDER BY slots.start_at
      `)
      .all(req.params.host);
    db.close();
    res.json(bookings);
  });

  return app;
}
