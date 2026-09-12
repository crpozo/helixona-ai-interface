/** Circuit breaker mínimo por modelo, en memoria (suficiente para 1-2 tareas). */
export interface BreakerOptions { failureThreshold?: number; windowMs?: number; openMs?: number; now?: () => number }

export class CircuitBreaker {
  private failures = new Map<string, number[]>();
  private openUntil = new Map<string, { until: number; reason: string }>();
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 60_000;
    this.openMs = opts.openMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  isOpen(model: string): boolean {
    const o = this.openUntil.get(model);
    if (!o) return false;
    if (o.until <= this.now()) { this.openUntil.delete(model); return false; }
    return true;
  }

  state(model: string): "closed" | "open" { return this.isOpen(model) ? "open" : "closed"; }

  recordFailure(model: string, reason = "availability"): void {
    const t = this.now();
    const list = (this.failures.get(model) ?? []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.failures.set(model, list);
    if (list.length >= this.threshold) this.open(model, this.openMs, reason);
  }

  recordSuccess(model: string): void { this.failures.delete(model); }

  open(model: string, ms: number, reason: string): void {
    this.openUntil.set(model, { until: this.now() + ms, reason });
    this.failures.delete(model);
  }

  reset(model?: string): void {
    if (model) { this.failures.delete(model); this.openUntil.delete(model); return; }
    this.failures.clear(); this.openUntil.clear();
  }
}
