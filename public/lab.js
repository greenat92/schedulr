const STORAGE = {
  host: "schedulr.host",
  key: "schedulr.apiKey",
  otherHost: "schedulr.otherHost",
  otherKey: "schedulr.otherKey",
};

const credentials = {
  primary: {
    host: localStorage.getItem(STORAGE.host) || "alice",
    apiKey: localStorage.getItem(STORAGE.key) || "alice-key",
  },
  secondary: {
    host: localStorage.getItem(STORAGE.otherHost) || "bob",
    apiKey: localStorage.getItem(STORAGE.otherKey) || "bob-key",
  },
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
  }, 3500);
}

function newId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeader(creds) {
  return creds && creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {};
}

async function call(path, { method = "GET", body, auth, extraHeaders } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) Object.assign(headers, authHeader(auth));
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const started = performance.now();
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
  return { status: response.status, headers: response.headers, body: data, ms: performance.now() - started };
}

function futureIso(extraMs = 0) {
  const base = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return new Date(base + Math.floor(Math.random() * 1_000_000) + extraMs).toISOString();
}

function createSlot(creds, startAt, duration = 30) {
  return call("/slots", {
    method: "POST",
    auth: creds,
    body: { host: creds.host, start_at: startAt, duration_minutes: duration },
  });
}

function recorder() {
  const lines = [];
  let ok = true;
  return {
    check(condition, text) {
      ok = ok && Boolean(condition);
      lines.push({ ok: Boolean(condition), text });
    },
    note(text) {
      lines.push({ ok: true, text, info: true });
    },
    result() {
      return { ok, lines };
    },
  };
}

// --- metrics ---------------------------------------------------------------

function parseMetrics(text) {
  const samples = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)$/.exec(line);
    if (!match) continue;

    const labels = {};
    const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let labelMatch;
    while ((labelMatch = labelPattern.exec(match[2] || "")) !== null) {
      labels[labelMatch[1]] = labelMatch[2];
    }
    samples.push({ name: match[1], labels, value: Number.parseFloat(match[3]) });
  }
  return samples;
}

function metricSum(samples, name, labels = {}) {
  return samples
    .filter(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((total, sample) => total + sample.value, 0);
}

function metricLast(samples, name) {
  const found = samples.filter((sample) => sample.name === name);
  return found.length > 0 ? found[found.length - 1].value : 0;
}

async function metricsSnapshot() {
  const response = await call("/metrics");
  return parseMetrics(typeof response.body === "string" ? response.body : "");
}

// --- scenarios -------------------------------------------------------------

const scenarios = [
  {
    id: "validation",
    group: "Correctness",
    title: "Input validation returns 4xx, not 500s",
    description: "Bad dates and missing auth are rejected cleanly.",
    run: async () => {
      const r = recorder();
      const badDate = await createSlot(credentials.primary, "not-a-date");
      r.check(badDate.status === 400, `invalid start_at -> ${badDate.status} (expected 400)`);

      const noAuth = await call("/slots", {
        method: "POST",
        body: { host: credentials.primary.host, start_at: futureIso() },
      });
      r.check(noAuth.status === 401, `missing auth -> ${noAuth.status} (expected 401)`);

      const badBook = await call("/book", {
        method: "POST",
        body: { slot_id: "abc", guest_name: "X", guest_email: "x@example.com" },
      });
      r.check(badBook.status === 400, `non-numeric slot_id -> ${badBook.status} (expected 400)`);
      return r.result();
    },
  },
  {
    id: "past",
    group: "Correctness",
    title: "Past slots cannot be created",
    description: "start_at in the past is refused.",
    run: async () => {
      const r = recorder();
      const response = await createSlot(credentials.primary, "2020-01-01T00:00:00.000Z");
      r.check(response.status === 400, `past slot -> ${response.status} (expected 400)`);
      return r.result();
    },
  },
  {
    id: "duplicate",
    group: "Correctness",
    title: "Duplicate slots are rejected",
    description: "Same host + start time is blocked by a unique index.",
    run: async () => {
      const r = recorder();
      const start = futureIso();
      const first = await createSlot(credentials.primary, start);
      const second = await createSlot(credentials.primary, start);
      r.check(first.status === 201, `first create -> ${first.status} (expected 201)`);
      r.check(second.status === 409, `duplicate -> ${second.status} (expected 409)`);
      return r.result();
    },
  },
  {
    id: "race",
    group: "Correctness",
    title: "Concurrent booking cannot double-book",
    description: "Eight simultaneous bookings for one slot: exactly one wins.",
    run: async () => {
      const r = recorder();
      const slot = await createSlot(credentials.primary, futureIso());
      if (slot.status !== 201) {
        r.check(false, `setup slot -> ${slot.status}`);
        return r.result();
      }

      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          call("/book", {
            method: "POST",
            body: {
              slot_id: slot.body.id,
              guest_name: `Race ${index}`,
              guest_email: `race${index}@example.com`,
            },
          }),
        ),
      );

      const created = attempts.filter((attempt) => attempt.status === 201).length;
      const conflicts = attempts.filter((attempt) => attempt.status === 409).length;
      r.check(created === 1, `accepted bookings -> ${created} (expected 1)`);
      r.check(conflicts === 7, `rejected as conflict -> ${conflicts} (expected 7)`);

      const availability = await call(
        `/availability/${encodeURIComponent(credentials.primary.host)}?limit=500`,
      );
      const stillListed =
        Array.isArray(availability.body) && availability.body.some((row) => row.id === slot.body.id);
      r.check(!stillListed, "booked slot is no longer advertised");
      return r.result();
    },
  },
  {
    id: "idempotency",
    group: "Correctness",
    title: "Idempotency keys make retries safe",
    description: "Replay returns the original booking; key reuse with a new payload is refused.",
    run: async () => {
      const r = recorder();
      const slot = await createSlot(credentials.primary, futureIso());
      const key = `lab-${newId()}`;
      const body = { slot_id: slot.body.id, guest_name: "Idem", guest_email: "idem@example.com" };

      const first = await call("/book", {
        method: "POST",
        body,
        extraHeaders: { "Idempotency-Key": key },
      });
      const replay = await call("/book", {
        method: "POST",
        body,
        extraHeaders: { "Idempotency-Key": key },
      });
      const different = await call("/book", {
        method: "POST",
        body: { ...body, guest_name: "Someone else" },
        extraHeaders: { "Idempotency-Key": key },
      });

      r.check(first.status === 201, `first booking -> ${first.status} (expected 201)`);
      r.check(
        replay.status === 201 && replay.body?.booking_id === first.body?.booking_id,
        `replay -> same booking id (${first.body?.booking_id})`,
      );
      r.check(
        different.status === 422,
        `key reuse with different payload -> ${different.status} (expected 422)`,
      );
      return r.result();
    },
  },
  {
    id: "authorization",
    group: "Correctness",
    title: "Guest PII is not publicly readable",
    description: "Bookings require the owning host's API key.",
    run: async () => {
      const r = recorder();
      const path = `/bookings/${encodeURIComponent(credentials.primary.host)}`;

      const unauth = await call(path);
      r.check(unauth.status === 401, `no auth -> ${unauth.status} (expected 401)`);

      const own = await call(path, { auth: credentials.primary });
      r.check(own.status === 200, `own bookings -> ${own.status} (expected 200)`);

      if (
        credentials.secondary.host &&
        credentials.secondary.host !== credentials.primary.host &&
        credentials.secondary.apiKey
      ) {
        const cross = await call(path, { auth: credentials.secondary });
        r.check(cross.status === 403, `other host -> ${cross.status} (expected 403)`);
      } else {
        r.note("Secondary host equals primary; cross-host check skipped.");
      }
      return r.result();
    },
  },
  {
    id: "pagination",
    group: "Correctness",
    title: "Keyset pagination",
    description: "Pages follow an opaque cursor instead of deep offsets.",
    run: async () => {
      const r = recorder();
      const host = encodeURIComponent(credentials.primary.host);

      await Promise.all([
        createSlot(credentials.primary, futureIso(1_000)),
        createSlot(credentials.primary, futureIso(2_000)),
        createSlot(credentials.primary, futureIso(3_000)),
      ]);

      const first = await call(`/availability/${host}?limit=2`);
      const cursor = first.headers.get("x-next-cursor");
      r.check(
        first.status === 200 && Array.isArray(first.body) && first.body.length === 2,
        `first page -> ${Array.isArray(first.body) ? first.body.length : "?"} items`,
      );
      r.check(Boolean(cursor), "X-Next-Cursor returned for the next page");

      if (cursor) {
        const second = await call(
          `/availability/${host}?limit=2&cursor=${encodeURIComponent(cursor)}`,
        );
        r.check(second.status === 200 && Array.isArray(second.body), `cursor page -> ${second.status}`);
      }

      const invalid = await call(`/availability/${host}?cursor=not-a-cursor`);
      r.check(invalid.status === 400, `invalid cursor -> ${invalid.status} (expected 400)`);
      return r.result();
    },
  },
  {
    id: "health",
    group: "Production readiness",
    title: "Health & readiness",
    description: "Liveness, DB readiness, and schema version are observable.",
    run: async () => {
      const r = recorder();
      const health = await call("/healthz");
      const ready = await call("/readyz");
      const config = await call("/config");

      r.check(
        health.status === 200 && health.body?.status === "ok",
        `healthz -> ${health.status} ${health.body?.status ?? ""}`,
      );
      r.check(
        ready.status === 200 && ready.body?.status === "ready",
        `readyz -> ${ready.status} ${ready.body?.status ?? ""}`,
      );
      r.check(config.status === 200, `/config reachable (schema v${config.body?.schemaVersion})`);
      return r.result();
    },
  },
  {
    id: "request-id",
    group: "Production readiness",
    title: "Request correlation",
    description: "Every response carries X-Request-Id; inbound ids are echoed.",
    run: async () => {
      const r = recorder();
      const trace = `lab-${newId()}`;
      const response = await call("/healthz", { extraHeaders: { "x-request-id": trace } });
      r.check(
        response.headers.get("x-request-id") === trace,
        `correlation id echoed (${response.headers.get("x-request-id")})`,
      );
      return r.result();
    },
  },
  {
    id: "compression",
    group: "Production readiness",
    title: "Response compression",
    description: "Large list responses are gzipped.",
    run: async () => {
      const r = recorder();
      for (let index = 0; index < 20; index++) {
        await createSlot(credentials.primary, futureIso(index * 1_000));
      }
      const response = await call(`/availability/${encodeURIComponent(credentials.primary.host)}`);
      r.check(response.status === 200, `availability -> ${response.status}`);
      const encoding = response.headers.get("content-encoding");
      r.check(
        encoding === "gzip",
        `content-encoding = ${encoding ?? "(none)"} (gzip expected for a large payload)`,
      );
      return r.result();
    },
  },
  {
    id: "cache",
    group: "Production readiness",
    title: "Availability cache",
    description: "Repeated reads are served from the in-process cache.",
    run: async () => {
      const r = recorder();
      const host = encodeURIComponent(credentials.primary.host);
      const before = await metricsSnapshot();
      await call(`/availability/${host}?limit=1`);
      await call(`/availability/${host}?limit=1`);
      const after = await metricsSnapshot();

      const hits =
        metricSum(after, "availability_cache_total", { result: "hit" }) -
        metricSum(before, "availability_cache_total", { result: "hit" });
      r.check(hits >= 1, `cache hits increased by ${hits} on a repeated read`);
      return r.result();
    },
  },
  {
    id: "shared-connection",
    group: "Production readiness",
    title: "Shared DB connection",
    description: "A burst of reads opens no additional SQLite connections.",
    run: async () => {
      const r = recorder();
      const host = encodeURIComponent(credentials.primary.host);
      const before = await metricsSnapshot();
      await Promise.all(Array.from({ length: 30 }, () => call(`/availability/${host}`)));
      const after = await metricsSnapshot();

      const opened =
        metricSum(after, "db_connections_opened_total") -
        metricSum(before, "db_connections_opened_total");
      r.check(opened === 0, `connections opened during 30 requests -> ${opened} (expected 0)`);
      return r.result();
    },
  },
  {
    id: "email-outbox",
    group: "Production readiness",
    title: "Durable email delivery",
    description: "Booking enqueues email; the worker drains it asynchronously.",
    run: async () => {
      const r = recorder();
      const before = await metricsSnapshot();
      const slot = await createSlot(credentials.primary, futureIso());
      const booking = await call("/book", {
        method: "POST",
        body: {
          slot_id: slot.body.id,
          guest_name: "Mailbox",
          guest_email: "mailbox@example.com",
        },
      });
      r.check(booking.status === 201, `booking recorded -> ${booking.status} (expected 201)`);

      let after = before;
      let pending = Number.POSITIVE_INFINITY;
      let delivered = 0;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await sleep(400);
        after = await metricsSnapshot();
        pending = metricLast(after, "email_outbox_pending");
        delivered =
          metricSum(after, "email_deliveries_total", { result: "success" }) -
          metricSum(before, "email_deliveries_total", { result: "success" });
        if (pending === 0 && delivered >= 1) break;
      }

      r.check(delivered >= 1, `emails delivered asynchronously -> ${delivered}`);
      r.check(pending === 0, `outbox drained (pending gauge ${pending})`);
      return r.result();
    },
  },
  {
    id: "metrics",
    group: "Production readiness",
    title: "Metrics & observability",
    description: "RED metrics, DB, email, cache, and event-loop lag are exposed.",
    run: async () => {
      const r = recorder();
      const snapshot = await metricsSnapshot();
      const requests = metricSum(snapshot, "http_requests_total");
      r.check(requests > 0, `http_requests_total present (${requests})`);
      r.check(
        snapshot.some((sample) => sample.name === "http_request_duration_seconds_bucket"),
        "request latency histogram exposed",
      );
      r.check(
        snapshot.some((sample) => sample.name === "db_connections_opened_total"),
        "db_connections_opened_total exposed",
      );
      r.check(
        snapshot.some((sample) => sample.name === "email_deliveries_total"),
        "email_deliveries_total exposed",
      );
      r.check(
        snapshot.some((sample) => sample.name === "event_loop_lag_seconds"),
        "event_loop_lag_seconds exposed",
      );
      return r.result();
    },
  },
  {
    id: "rate-limit",
    group: "Production readiness",
    title: "Rate limiting",
    description: "Per-IP limit returns 429 with Retry-After.",
    run: async () => {
      const r = recorder();
      const config = await call("/config");
      const max = config.body?.rateLimit?.max;
      const windowMs = config.body?.rateLimit?.windowMs;

      if (typeof max !== "number") {
        r.check(false, "could not read rate-limit configuration");
        return r.result();
      }

      r.note(`configured ${max} requests / ${Math.round((windowMs ?? 0) / 1000)}s per IP`);
      if (max <= 50) {
        const responses = await Promise.all(
          Array.from({ length: max + 1 }, () => call("/availability/rate-limit-probe")),
        );
        const limited = responses.filter((response) => response.status === 429).length;
        r.check(limited >= 1, `over the limit -> ${limited} response(s) with 429`);
        const retryAfter = responses.find((response) => response.status === 429)?.headers.get("retry-after");
        r.check(Boolean(retryAfter), `Retry-After header present (${retryAfter ?? "missing"})`);
      } else {
        r.note("Limit is high by default; start with RATE_LIMIT_MAX=10 to trigger 429 here.");
      }
      return r.result();
    },
  },
];

// --- rendering / wiring ----------------------------------------------------

function buildScenarioCard(scenario) {
  const article = document.createElement("article");
  article.className = "scenario";

  const head = document.createElement("div");
  head.className = "scenario-head";

  const info = document.createElement("div");
  const title = document.createElement("h4");
  title.textContent = scenario.title;
  const description = document.createElement("p");
  description.className = "muted";
  description.textContent = scenario.description;
  info.append(title, description);

  const actions = document.createElement("div");
  actions.className = "scenario-actions";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "idle";
  badge.dataset.badge = scenario.id;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Run";
  button.addEventListener("click", () => void runScenario(scenario));
  actions.append(badge, button);

  head.append(info, actions);
  const checks = document.createElement("ul");
  checks.className = "checks";
  checks.dataset.checks = scenario.id;
  article.append(head, checks);
  return article;
}

function renderScenarios() {
  const container = $("scenarios");
  container.replaceChildren();
  for (const groupName of ["Correctness", "Production readiness"]) {
    const group = document.createElement("div");
    group.className = "scenario-group";
    const heading = document.createElement("h3");
    heading.textContent = groupName;
    group.append(heading);
    for (const scenario of scenarios.filter((candidate) => candidate.group === groupName)) {
      group.append(buildScenarioCard(scenario));
    }
    container.append(group);
  }
}

function setBadge(id, state, text) {
  const badge = document.querySelector(`[data-badge="${id}"]`);
  if (!badge) return;
  badge.className = `badge ${state}`;
  badge.textContent = text;
}

function renderChecks(id, lines) {
  const list = document.querySelector(`[data-checks="${id}"]`);
  if (!list) return;
  list.replaceChildren();
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line.text;
    if (!line.info) item.className = line.ok ? "pass" : "fail";
    list.append(item);
  }
}

async function runScenario(scenario) {
  setBadge(scenario.id, "running", "running");
  renderChecks(scenario.id, []);
  try {
    const { ok, lines } = await scenario.run();
    setBadge(scenario.id, ok ? "pass" : "fail", ok ? "pass" : "fail");
    renderChecks(scenario.id, lines);
    return ok;
  } catch (error) {
    setBadge(scenario.id, "fail", "fail");
    renderChecks(scenario.id, [{ ok: false, text: `Error: ${error.message}` }]);
    return false;
  }
}

async function runGroup(groupName) {
  for (const scenario of scenarios.filter((candidate) => candidate.group === groupName)) {
    await runScenario(scenario);
  }
  await refreshMetrics();
}

const METRIC_SPECS = [
  { label: "Requests", name: "http_requests_total" },
  { label: "Bookings ok", name: "bookings_total", labels: { result: "success" } },
  { label: "Conflicts", name: "bookings_total", labels: { result: "conflict" } },
  { label: "Emails sent", name: "email_deliveries_total", labels: { result: "success" } },
  { label: "Email failures", name: "email_deliveries_total", labels: { result: "failure" } },
  { label: "DB opens", name: "db_connections_opened_total" },
  { label: "Cache hits", name: "availability_cache_total", labels: { result: "hit" } },
  { label: "Cache misses", name: "availability_cache_total", labels: { result: "miss" } },
  { label: "Outbox pending", name: "email_outbox_pending", gauge: true },
  { label: "Loop lag (s)", name: "event_loop_lag_seconds", gauge: true, decimals: 4 },
];

async function refreshMetrics() {
  const panel = $("metrics-panel");
  try {
    const snapshot = await metricsSnapshot();
    panel.replaceChildren();
    for (const spec of METRIC_SPECS) {
      const value = spec.gauge
        ? metricLast(snapshot, spec.name)
        : metricSum(snapshot, spec.name, spec.labels);
      const card = document.createElement("div");
      card.className = "metric";
      const key = document.createElement("div");
      key.className = "k";
      key.textContent = spec.label;
      const val = document.createElement("div");
      val.className = "v";
      val.textContent =
        spec.decimals !== undefined ? value.toFixed(spec.decimals) : value.toLocaleString();
      card.append(key, val);
      panel.append(card);
    }
  } catch (error) {
    panel.replaceChildren();
    toast(`Could not load metrics: ${error.message}`, "error");
  }
}

function saveCredentials(event) {
  event.preventDefault();
  credentials.primary.host = $("primary-host").value.trim() || credentials.primary.host;
  credentials.primary.apiKey = $("primary-key").value.trim() || credentials.primary.apiKey;
  credentials.secondary.host = $("secondary-host").value.trim() || credentials.secondary.host;
  credentials.secondary.apiKey = $("secondary-key").value.trim() || credentials.secondary.apiKey;

  localStorage.setItem(STORAGE.host, credentials.primary.host);
  localStorage.setItem(STORAGE.key, credentials.primary.apiKey);
  localStorage.setItem(STORAGE.otherHost, credentials.secondary.host);
  localStorage.setItem(STORAGE.otherKey, credentials.secondary.apiKey);
  toast("Credentials saved.", "ok");
}

function init() {
  $("primary-host").value = credentials.primary.host;
  $("primary-key").value = credentials.primary.apiKey;
  $("secondary-host").value = credentials.secondary.host;
  $("secondary-key").value = credentials.secondary.apiKey;

  renderScenarios();

  $("credentials").addEventListener("submit", saveCredentials);
  $("run-all").addEventListener("click", () => void runGroup("Correctness").then(() => runGroup("Production readiness")).then(() => toast("All scenarios finished.", "ok")));
  $("run-correctness").addEventListener("click", () => void runGroup("Correctness"));
  $("run-production").addEventListener("click", () => void runGroup("Production readiness"));
  $("refresh-metrics").addEventListener("click", () => void refreshMetrics());

  void refreshMetrics();
}

init();
