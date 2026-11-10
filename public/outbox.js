import { fetchMetrics, metricLast, metricSum } from "./metrics.js";

const STORAGE = { host: "schedulr.host", key: "schedulr.apiKey" };

const state = {
  host: localStorage.getItem(STORAGE.host) || "alice",
  apiKey: localStorage.getItem(STORAGE.key) || "alice-key",
  interval: null,
  retry: null,
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

function newId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function api(path, { method = "GET", body, auth = false, extraHeaders } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
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
    const error = new Error(
      response.status === 429
        ? rateLimitMessage(response)
        : data && data.error
          ? data.error
          : `Request failed (${response.status})`,
    );
    error.status = response.status;
    error.retryAfter = Number(response.headers.get("retry-after")) || null;
    throw error;
  }
  return data;
}

function parseDbTime(value) {
  if (!value) return null;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWhen(value, relative = false) {
  const date = parseDbTime(value);
  if (!date) return "—";
  if (relative) {
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds >= -1 && seconds < 60) return seconds <= 0 ? "just now" : `${seconds}s ago`;
    if (seconds < 0) return `in ${Math.abs(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  }
  return date.toLocaleString();
}

function setStats(stats) {
  $("stat-pending").textContent = (stats.pending ?? 0).toLocaleString();
  $("stat-sending").textContent = (stats.sending ?? 0).toLocaleString();
  $("stat-sent").textContent = (stats.sent ?? 0).toLocaleString();
  $("stat-failed").textContent = (stats.failed ?? 0).toLocaleString();
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderRows(rows) {
  const body = $("outbox-rows");
  body.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 8;
    td.textContent = "No outbox rows yet. Generate a booking to watch the worker run.";
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(cell(String(row.id), "mono"));
    tr.append(cell(String(row.booking_id), "mono"));
    tr.append(cell(row.to_email));
    const statusCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `pill ${row.status}`;
    pill.textContent = row.status;
    statusCell.append(pill);
    tr.append(statusCell);
    tr.append(cell(String(row.attempts), "mono"));
    tr.append(cell(formatWhen(row.next_attempt_at, row.status === "pending"), "mono"));
    const errorCell = cell(row.last_error ?? "—");
    errorCell.title = row.last_error ?? "";
    tr.append(errorCell);
    tr.append(cell(formatWhen(row.created_at), "mono"));
    body.append(tr);
  }
}

async function loadWorkerMetrics() {
  const samples = await fetchMetrics();
  $("stat-delivered").textContent = metricSum(samples, "email_deliveries_total", {
    result: "success",
  }).toLocaleString();
  $("stat-delivery-failures").textContent = metricSum(samples, "email_deliveries_total", {
    result: "failure",
  }).toLocaleString();
  $("stat-cycles").textContent = metricSum(samples, "email_worker_cycles_total").toLocaleString();

  const lastRun = metricLast(samples, "email_worker_last_run_timestamp_seconds");
  $("stat-last-run").textContent = lastRun
    ? `${Math.max(0, Math.round(Date.now() / 1000 - lastRun))}s ago`
    : "—";
  $("stat-lag").textContent = metricLast(samples, "event_loop_lag_seconds").toFixed(4);
}

function setBanner(text) {
  const banner = $("banner");
  if (!text) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.textContent = text;
}

async function refresh() {
  try {
    const data = await api(`/outbox?limit=100`, { auth: true });
    setStats(data.stats ?? {});
    renderRows(Array.isArray(data.rows) ? data.rows : []);
    setBanner("");
  } catch (error) {
    if (error.status === 429) {
      // The outbox API is limited, but the worker is server-side and keeps
      // running. Back off until Retry-After instead of hammering.
      setBanner(
        `Rate limited — the email worker keeps running. This dashboard will refresh in ${
          error.retryAfter ?? 5
        }s.`,
      );
      scheduleRetry(error.retryAfter);
    } else {
      toast(error.message, "error");
    }
  }

  // Metrics are never rate limited, so worker liveness stays visible even while
  // the outbox API is throttled.
  try {
    await loadWorkerMetrics();
  } catch {
    // ignore metric scrape failures
  }

  $("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`;

  if (!state.interval && !state.retry && $("auto-refresh").checked) {
    schedule();
  }
}

function stopTimers() {
  if (state.interval) clearInterval(state.interval);
  if (state.retry) clearTimeout(state.retry);
  state.interval = null;
  state.retry = null;
}

function schedule() {
  stopTimers();
  if ($("auto-refresh").checked) {
    state.interval = setInterval(() => void refresh(), Number($("interval").value));
  }
}

function scheduleRetry(seconds) {
  stopTimers();
  const delay = Math.max(1, Number(seconds) || 5) * 1000;
  state.retry = setTimeout(() => {
    if ($("auto-refresh").checked) void refresh();
  }, delay);
}

function futureIso() {
  const base = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return new Date(base + Math.floor(Math.random() * 1_000_000)).toISOString();
}

async function generateBooking(index, total) {
  const slot = await api("/slots", {
    method: "POST",
    auth: true,
    body: { host: state.host, start_at: futureIso(), duration_minutes: 30 },
  });
  await api("/book", {
    method: "POST",
    body: {
      slot_id: slot.id,
      guest_name: `Worker demo ${index + 1}/${total}`,
      guest_email: `worker-${Date.now()}-${index}@example.com`,
    },
    extraHeaders: { "Idempotency-Key": newId() },
  });
}

async function generate(count) {
  const buttons = [
    $("generate-one"),
    $("generate-five"),
    $("generate-hundred"),
    $("refresh"),
  ];
  buttons.forEach((button) => (button.disabled = true));

  const status = $("generate-status");
  let done = 0;
  let cursor = 0;
  status.textContent = `generating 0/${count}…`;

  try {
    const workers = Array.from({ length: Math.min(5, count) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= count) return;
        await generateBooking(index, count);
        done += 1;
        status.textContent = `generating ${done}/${count}…`;
      }
    });

    const results = await Promise.allSettled(workers);
    const failures = results.filter((result) => result.status === "rejected");

    if (failures.length > 0) {
      const reason = failures[0]?.reason;
      const limited = reason && reason.status === 429;
      status.textContent = limited
        ? `rate limited after ${done}/${count}`
        : `queued ${done}/${count} (${failures.length} worker(s) stopped)`;
      toast(reason instanceof Error ? reason.message : "Some bookings failed.", "error");
    } else {
      status.textContent = `queued ${count} email(s)`;
      toast(`Queued ${count} confirmation email(s).`, "ok");
    }
    await refresh();
  } catch (error) {
    status.textContent = `stopped after ${done}/${count}`;
    toast(error.message, "error");
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

function saveCredentials(event) {
  event.preventDefault();
  state.host = $("host").value.trim() || state.host;
  state.apiKey = $("key").value.trim() || state.apiKey;
  localStorage.setItem(STORAGE.host, state.host);
  localStorage.setItem(STORAGE.key, state.apiKey);
  toast("Credentials saved.", "ok");
  void refresh();
}

function init() {
  $("host").value = state.host;
  $("key").value = state.apiKey;

  $("credentials").addEventListener("submit", saveCredentials);
  $("refresh").addEventListener("click", () => void refresh());
  $("generate-one").addEventListener("click", () => void generate(1));
  $("generate-five").addEventListener("click", () => void generate(5));
  $("generate-hundred").addEventListener("click", () => void generate(100));
  $("auto-refresh").addEventListener("change", schedule);
  $("interval").addEventListener("change", schedule);

  void refresh();
  schedule();
}

init();
