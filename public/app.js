const STORAGE = { host: "schedulr.host", key: "schedulr.apiKey" };

const state = {
  host: localStorage.getItem(STORAGE.host) || "alice",
  apiKey: localStorage.getItem(STORAGE.key) || "alice-key",
  pendingSlot: null,
};

const $ = (id) => document.getElementById(id);

let toastTimer;
function toast(message, kind = "ok") {
  const element = $("toast");
  element.textContent = message;
  element.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.className = "toast";
  }, kind === "error" ? 8000 : 3500);
}

function rateLimitMessage(response) {
  const seconds = response.headers.get("retry-after");
  return seconds
    ? `Too many requests. Please wait ${seconds}s and try again.`
    : "Too many requests. Please wait a moment and try again.";
}

function authHeaders() {
  return state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {};
}

async function request(path, { method = "GET", body, auth = false, extraHeaders } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) Object.assign(headers, authHeaders());
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(rateLimitMessage(response));
    }
    const message = data && data.error ? data.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function defaultStartValue() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function emptyState(text) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

function renderAvailability(slots) {
  const list = $("availability-list");
  list.replaceChildren();

  if (slots.length === 0) {
    list.append(emptyState("No open slots for this host."));
    return;
  }

  for (const slot of slots) {
    const item = document.createElement("li");

    const main = document.createElement("div");
    main.className = "slot-main";
    const time = document.createElement("span");
    time.className = "slot-time";
    time.textContent = formatDate(slot.start_at);
    const meta = document.createElement("span");
    meta.className = "slot-meta";
    meta.textContent = `${slot.duration_minutes} min · slot #${slot.id}`;
    main.append(time, meta);

    const bookButton = document.createElement("button");
    bookButton.type = "button";
    bookButton.textContent = "Book";
    bookButton.addEventListener("click", () => openBook(slot));

    item.append(main, bookButton);
    list.append(item);
  }
}

function renderBookings(bookings) {
  const list = $("bookings-list");
  list.replaceChildren();

  if (bookings.length === 0) {
    list.append(emptyState("No bookings yet."));
    return;
  }

  for (const booking of bookings) {
    const item = document.createElement("li");
    const main = document.createElement("div");
    main.className = "slot-main";

    const time = document.createElement("span");
    time.className = "slot-time";
    time.textContent = formatDate(booking.start_at);

    const meta = document.createElement("span");
    meta.className = "slot-meta";
    meta.textContent = `${booking.guest_name} · ${booking.guest_email} · ${booking.duration_minutes} min`;

    main.append(time, meta);
    item.append(main);
    list.append(item);
  }
}

function availabilityHost() {
  return $("availability-host").value.trim() || state.host;
}

async function loadAvailability() {
  const list = $("availability-list");
  list.replaceChildren(emptyState("Loading…"));
  try {
    const slots = await request(`/availability/${encodeURIComponent(availabilityHost())}`);
    renderAvailability(Array.isArray(slots) ? slots : []);
  } catch (error) {
    list.replaceChildren();
    toast(error.message, "error");
  }
}

async function loadBookings() {
  const list = $("bookings-list");
  list.replaceChildren(emptyState("Loading…"));
  try {
    const bookings = await request(`/bookings/${encodeURIComponent(state.host)}`, { auth: true });
    renderBookings(Array.isArray(bookings) ? bookings : []);
  } catch (error) {
    list.replaceChildren();
    toast(error.message, "error");
  }
}

async function refreshAll() {
  await Promise.all([loadAvailability(), loadBookings()]);
}

function openBook(slot) {
  state.pendingSlot = slot;
  $("book-slot-summary").textContent = `${formatDate(slot.start_at)} · ${
    slot.duration_minutes
  } min with ${availabilityHost()}`;
  $("book-name").value = "";
  $("book-email").value = "";
  $("book-dialog").showModal();
  $("book-name").focus();
}

function newIdempotencyKey() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function applyAuth(event) {
  event.preventDefault();
  const host = $("auth-host").value.trim();
  const key = $("auth-key").value.trim();

  if (!host || !key) {
    toast("Host and API key are required.", "error");
    return;
  }

  state.host = host;
  state.apiKey = key;
  localStorage.setItem(STORAGE.host, host);
  localStorage.setItem(STORAGE.key, key);
  $("availability-host").value = host;
  toast(`Signed in as ${host}`, "ok");
  void refreshAll();
}

async function createSlot(event) {
  event.preventDefault();
  const startLocal = $("slot-start").value;
  if (!startLocal) return;

  const startAt = new Date(startLocal).toISOString();
  const duration = Number($("slot-duration").value);
  const button = $("slot-form").querySelector("button");
  button.disabled = true;

  try {
    await request("/slots", {
      method: "POST",
      auth: true,
      body: { host: state.host, start_at: startAt, duration_minutes: duration },
    });
    toast("Slot created.", "ok");
    $("slot-start").value = defaultStartValue();
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function confirmBooking() {
  const slot = state.pendingSlot;
  if (!slot || !$("book-form").reportValidity()) return;

  const button = $("book-confirm");
  button.disabled = true;

  try {
    await request("/book", {
      method: "POST",
      body: {
        slot_id: slot.id,
        guest_name: $("book-name").value.trim(),
        guest_email: $("book-email").value.trim(),
      },
      extraHeaders: { "Idempotency-Key": newIdempotencyKey() },
    });
    $("book-dialog").close();
    toast("Booked! A confirmation email is on its way.", "ok");
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function init() {
  $("auth-host").value = state.host;
  $("auth-key").value = state.apiKey;
  $("availability-host").value = state.host;
  $("slot-start").value = defaultStartValue();

  $("auth-form").addEventListener("submit", applyAuth);
  $("slot-form").addEventListener("submit", createSlot);
  $("availability-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void loadAvailability();
  });
  $("refresh-bookings").addEventListener("click", () => void loadBookings());
  $("book-cancel").addEventListener("click", () => $("book-dialog").close());
  $("book-confirm").addEventListener("click", () => void confirmBooking());

  void refreshAll();
}

init();
