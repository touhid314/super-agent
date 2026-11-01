import type { AccountStatus } from '../types';

/** Live per-account status: concurrency slots, cooldowns after rate limits, login info. */
export class AccountPool {
  private status = new Map<string, AccountStatus>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  get(id: string): AccountStatus {
    let s = this.status.get(id);
    if (!s) {
      s = { login: 'unknown', busyRuns: 0 };
      this.status.set(id, s);
    }
    return s;
  }

  patch(id: string, patch: Partial<AccountStatus>): void {
    this.status.set(id, { ...this.get(id), ...patch });
    this.notify();
  }

  all(): Record<string, AccountStatus> {
    return Object.fromEntries(this.status);
  }

  delete(id: string): void {
    this.status.delete(id);
    this.notify();
  }

  available(id: string, maxConcurrent: number, now = Date.now()): boolean {
    const s = this.get(id);
    if (s.cooldownUntil && s.cooldownUntil > now) return false;
    if (s.login === 'signed-out') return false;
    return s.busyRuns < maxConcurrent;
  }

  acquire(id: string): void {
    this.patch(id, { busyRuns: this.get(id).busyRuns + 1 });
  }

  release(id: string): void {
    this.patch(id, { busyRuns: Math.max(0, this.get(id).busyRuns - 1) });
  }

  coolDown(id: string, minutes: number, reason: string): void {
    this.patch(id, { cooldownUntil: Date.now() + minutes * 60000, lastError: reason });
  }
}
