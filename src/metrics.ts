export type Labels = Record<string, string>;

interface CounterEntry {
  name: string;
  labels: Labels;
  value: number;
}

interface HistogramEntry {
  name: string;
  labels: Labels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

interface GaugeEntry {
  name: string;
  labels: Labels;
  value: number;
}

const DEFAULT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderKey(name: string, labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

class MetricsRegistry {
  private counters = new Map<string, CounterEntry>();
  private histograms = new Map<string, HistogramEntry>();
  private gauges = new Map<string, GaugeEntry>();

  inc(name: string, labels: Labels = {}, value = 1): void {
    const key = renderKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.counters.set(key, { name, labels, value });
    }
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = renderKey(name, labels);
    let entry = this.histograms.get(key);
    if (!entry) {
      entry = {
        name,
        labels,
        buckets: DEFAULT_BUCKETS,
        counts: DEFAULT_BUCKETS.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, entry);
    }

    entry.sum += value;
    entry.count += 1;
    entry.buckets.forEach((bound, i) => {
      if (value <= bound) entry!.counts[i] += 1;
    });
  }

  gauge(name: string, value: number, labels: Labels = {}): void {
    const key = renderKey(name, labels);
    const existing = this.gauges.get(key);
    if (existing) {
      existing.value = value;
    } else {
      this.gauges.set(key, { name, labels, value });
    }
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  render(): string {
    const lines: string[] = [];

    const countersByName = new Map<string, CounterEntry[]>();
    for (const entry of this.counters.values()) {
      const group = countersByName.get(entry.name) ?? [];
      group.push(entry);
      countersByName.set(entry.name, group);
    }
    for (const [name, entries] of [...countersByName.entries()].sort()) {
      lines.push(`# TYPE ${name} counter`);
      for (const entry of entries.sort((a, b) => renderKey(a.name, a.labels).localeCompare(renderKey(b.name, b.labels)))) {
        lines.push(`${renderKey(entry.name, entry.labels)} ${entry.value}`);
      }
    }

    const histogramsByName = new Map<string, HistogramEntry[]>();
    for (const entry of this.histograms.values()) {
      const group = histogramsByName.get(entry.name) ?? [];
      group.push(entry);
      histogramsByName.set(entry.name, group);
    }
    for (const [name, entries] of [...histogramsByName.entries()].sort()) {
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of entries) {
        const renderEntry = (suffix: string, extra: Labels) =>
          renderKey(`${name}${suffix}`, { ...entry.labels, ...extra });
        entry.buckets.forEach((bound, i) => {
          lines.push(`${renderEntry("_bucket", { le: String(bound) })} ${entry.counts[i]}`);
        });
        lines.push(`${renderEntry("_bucket", { le: "+Inf" })} ${entry.count}`);
        lines.push(`${renderEntry("_sum", {})} ${entry.sum}`);
        lines.push(`${renderEntry("_count", {})} ${entry.count}`);
      }
    }

    const gaugesByName = new Map<string, GaugeEntry[]>();
    for (const entry of this.gauges.values()) {
      const group = gaugesByName.get(entry.name) ?? [];
      group.push(entry);
      gaugesByName.set(entry.name, group);
    }
    for (const [name, entries] of [...gaugesByName.entries()].sort()) {
      lines.push(`# TYPE ${name} gauge`);
      for (const entry of entries) {
        lines.push(`${renderKey(entry.name, entry.labels)} ${entry.value}`);
      }
    }

    lines.push("# TYPE process_uptime_seconds gauge");
    lines.push(`process_uptime_seconds ${process.uptime()}`);
    lines.push("# TYPE process_resident_memory_bytes gauge");
    lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);

    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new MetricsRegistry();

export function renderMetrics(): string {
  return metrics.render();
}

/**
 * Samples event-loop delay on a fixed cadence. A rising value is the clearest
 * signal that synchronous work (e.g. SQLite) is blocking the server.
 */
export function startEventLoopLagMonitor(intervalMs = 100): () => void {
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    metrics.gauge("event_loop_lag_seconds", Math.max(0, now - expected) / 1000);
    expected = now + intervalMs;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
