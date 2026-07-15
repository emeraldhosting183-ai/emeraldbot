import type { Logger } from "pino";

export const HEALTH_DEPENDENCIES = [
  "postgresql",
  "telegram",
  "ai",
] as const;

export type HealthDependency = (typeof HEALTH_DEPENDENCIES)[number];
export type HealthProbe = (signal: AbortSignal) => Promise<void>;

export interface DependencyHealth {
  readonly status: "up" | "down";
  readonly latencyMs: number;
}

export interface HealthReport {
  readonly status: "ok" | "degraded";
  readonly checkedAt: string;
  readonly cached: boolean;
  readonly dependencies: Readonly<Record<HealthDependency, DependencyHealth>>;
}

export interface HealthServiceOptions {
  readonly probes: Readonly<Record<HealthDependency, HealthProbe>>;
  readonly cacheTtlMs: number;
  readonly probeTimeoutMs?: number;
  readonly logger?: Pick<Logger, "warn">;
  readonly now?: () => number;
}

interface CachedHealthReport {
  readonly report: HealthReport;
  readonly expiresAt: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export class HealthService {
  private readonly probes: Readonly<Record<HealthDependency, HealthProbe>>;
  private readonly cacheTtlMs: number;
  private readonly probeTimeoutMs: number;
  private readonly logger: Pick<Logger, "warn"> | undefined;
  private readonly now: () => number;

  private cached: CachedHealthReport | undefined;
  private inFlight: Promise<HealthReport> | undefined;

  public constructor(options: HealthServiceOptions) {
    assertNonNegativeFinite(options.cacheTtlMs, "cacheTtlMs");
    assertPositiveFinite(
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      "probeTimeoutMs",
    );

    this.probes = options.probes;
    this.cacheTtlMs = options.cacheTtlMs;
    this.probeTimeoutMs =
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  public async check(options: { forceRefresh?: boolean } = {}): Promise<HealthReport> {
    const cached = this.cached;
    if (
      options.forceRefresh !== true &&
      cached !== undefined &&
      cached.expiresAt > this.now()
    ) {
      return { ...cached.report, cached: true };
    }

    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const pending = this.runChecks();
    this.inFlight = pending;

    try {
      const report = await pending;
      this.cached = {
        report,
        expiresAt: this.now() + this.cacheTtlMs,
      };
      return report;
    } finally {
      if (this.inFlight === pending) {
        this.inFlight = undefined;
      }
    }
  }

  public invalidate(): void {
    this.cached = undefined;
  }

  private async runChecks(): Promise<HealthReport> {
    const checkedAt = new Date(this.now()).toISOString();
    const results = await Promise.all(
      HEALTH_DEPENDENCIES.map(async (dependency) => {
        const health = await this.runProbe(dependency, this.probes[dependency]);
        return [dependency, health] as const;
      }),
    );
    const dependencies = Object.fromEntries(results) as Record<
      HealthDependency,
      DependencyHealth
    >;
    const healthy = HEALTH_DEPENDENCIES.every(
      (dependency) => dependencies[dependency].status === "up",
    );

    return {
      status: healthy ? "ok" : "degraded",
      checkedAt,
      cached: false,
      dependencies,
    };
  }

  private async runProbe(
    dependency: HealthDependency,
    probe: HealthProbe,
  ): Promise<DependencyHealth> {
    const startedAt = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Health probe timed out: ${dependency}`));
      }, this.probeTimeoutMs);
    });

    try {
      await Promise.race([
        Promise.resolve().then(() => probe(controller.signal)),
        timeout,
      ]);
      return {
        status: "up",
        latencyMs: elapsedMilliseconds(startedAt, this.now()),
      };
    } catch (error) {
      this.logger?.warn(
        { dependency, err: error },
        "Dependency health check failed",
      );
      return {
        status: "down",
        latencyMs: elapsedMilliseconds(startedAt, this.now()),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      controller.abort();
    }
  }
}

export function isHealthy(report: HealthReport): boolean {
  return report.status === "ok";
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}
