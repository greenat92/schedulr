interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Minimal TTL cache. TTL-bounded on purpose: with more than one process the
 * cache is per-process, so writes elsewhere are only reflected after expiry or
 * local invalidation. The TTL keeps that staleness window small.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    if (this.ttlMs <= 0) return undefined;

    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
