export function parseMetrics(text) {
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

export function metricSum(samples, name, labels = {}) {
  return samples
    .filter(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((total, sample) => total + sample.value, 0);
}

export function metricLast(samples, name) {
  const found = samples.filter((sample) => sample.name === name);
  return found.length > 0 ? found[found.length - 1].value : 0;
}

export async function fetchMetrics() {
  const response = await fetch("/metrics");
  return parseMetrics(await response.text());
}
