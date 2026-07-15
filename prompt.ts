import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.js";
import { ReplyJobStatus } from "../generated/prisma/enums.js";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;

export interface ReplyQueueOptions {
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitterRatio?: number;
  now?: () => Date;
  random?: () => number;
}

export interface EnqueueReplyOptions {
  chatId: string;
  sourceMessageId?: bigint | null;
  dueAt: Date;
}

export interface ClaimedReplyJob {
  id: string;
  chatId: string;
  revision: number;
  status: "PROCESSING";
  dueAt: Date;
  sourceMessageId: bigint | null;
  attempt: number;
  lockedAt: Date;
  leaseOwner: string;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReplyFenceState {
  revision: number;
  status: string;
  leaseOwner: string | null;
}

export interface RetryDelayOptions {
  baseMs?: number;
  maximumMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

interface ActiveRun {
  revision: number;
  controller: AbortController;
}

export class SupersededReplyError extends Error {
  public constructor() {
    super("Reply generation was superseded by a newer chat revision");
    this.name = "AbortError";
  }
}

/**
 * PostgreSQL is the source of truth for the queue. The in-memory controller map
 * only saves work when the newer revision is observed by this process; revision
 * and lease fencing remain authoritative across Railway replicas and restarts.
 */
export class ReplyQueue {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly retryJitterRatio: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly activeRuns = new Map<string, ActiveRun>();

  public constructor(
    private readonly database: PrismaClient,
    options: ReplyQueueOptions = {},
  ) {
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
    this.maxAttempts = positiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
    );
    this.retryBaseMs = positiveInteger(
      options.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
    );
    this.retryMaxMs = positiveInteger(
      options.retryMaxMs,
      DEFAULT_RETRY_MAX_MS,
    );
    this.retryJitterRatio = nonNegativeNumber(
      options.retryJitterRatio,
      DEFAULT_RETRY_JITTER_RATIO,
    );
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  public get heartbeatIntervalMs(): number {
    return Math.max(1_000, Math.floor(this.leaseMs / 3));
  }

  public createWorkerId(slot: number): string {
    return `${process.pid.toString(36)}-${slot.toString(36)}-${randomUUID()}`;
  }

  /** Contract used by the Telegram update processor. */
  public schedule(
    chatId: string,
    sourceMessageId: bigint | number | null,
    debounceMs: number,
  ) {
    const normalizedDebounceMs = Number.isFinite(debounceMs)
      ? Math.max(0, Math.floor(debounceMs))
      : 0;
    return this.enqueue({
      chatId,
      sourceMessageId:
        sourceMessageId === null ? null : BigInt(sourceMessageId),
      dueAt: new Date(this.now().getTime() + normalizedDebounceMs),
    });
  }

  public async enqueue(options: EnqueueReplyOptions) {
    const job = await this.database.replyJob.upsert({
      where: { chatId: options.chatId },
      create: {
        chatId: options.chatId,
        revision: 1,
        status: ReplyJobStatus.PENDING,
        dueAt: options.dueAt,
        sourceMessageId: options.sourceMessageId ?? null,
      },
      update: {
        revision: { increment: 1 },
        status: ReplyJobStatus.PENDING,
        dueAt: options.dueAt,
        sourceMessageId: options.sourceMessageId ?? null,
        attempt: 0,
        lockedAt: null,
        leaseOwner: null,
        lastErrorCode: null,
      },
    });

    this.abortOlderLocalRun(options.chatId, job.revision);
    return job;
  }

  /** Contract used by owner takeover, delete, pause, and deny handlers. */
  public cancel(chatId: string): Promise<boolean> {
    return this.invalidate(chatId);
  }

  public async invalidate(chatId: string): Promise<boolean> {
    const result = await this.database.replyJob.updateMany({
      where: { chatId },
      data: {
        revision: { increment: 1 },
        status: ReplyJobStatus.CANCELED,
        lockedAt: null,
        leaseOwner: null,
        lastErrorCode: "invalidated",
      },
    });

    this.abortLocalRun(chatId);
    return result.count > 0;
  }

  /** Atomically claims one due or stale-leased job across all app instances. */
  public async claimNext(workerId: string): Promise<ClaimedReplyJob | null> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.leaseMs);
    const rows = await this.database.$queryRaw<ClaimedReplyJob[]>`
      WITH candidate AS (
        SELECT "id"
        FROM "ReplyJob"
        WHERE
          (
            "status" = 'PENDING'::"ReplyJobStatus"
            AND "dueAt" <= ${now}
          )
          OR
          (
            "status" = 'PROCESSING'::"ReplyJobStatus"
            AND ("lockedAt" IS NULL OR "lockedAt" <= ${staleBefore})
          )
        ORDER BY
          CASE WHEN "status" = 'PROCESSING'::"ReplyJobStatus" THEN 0 ELSE 1 END,
          "dueAt" ASC,
          "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "ReplyJob" AS job
      SET
        "status" = 'PROCESSING'::"ReplyJobStatus",
        "lockedAt" = ${now},
        "leaseOwner" = ${workerId},
        "attempt" = job."attempt" + 1,
        "updatedAt" = ${now}
      FROM candidate
      WHERE job."id" = candidate."id"
      RETURNING
        job."id",
        job."chatId",
        job."revision",
        job."status",
        job."dueAt",
        job."sourceMessageId",
        job."attempt",
        job."lockedAt",
        job."leaseOwner",
        job."lastErrorCode",
        job."createdAt",
        job."updatedAt"
    `;

    return rows[0] ?? null;
  }

  public registerLocalRun(job: ClaimedReplyJob): AbortController {
    const previous = this.activeRuns.get(job.chatId);
    if (previous) {
      previous.controller.abort(new SupersededReplyError());
    }

    const controller = new AbortController();
    this.activeRuns.set(job.chatId, {
      revision: job.revision,
      controller,
    });
    return controller;
  }

  public releaseLocalRun(
    job: ClaimedReplyJob,
    controller: AbortController,
  ): void {
    const current = this.activeRuns.get(job.chatId);
    if (current?.controller === controller) {
      this.activeRuns.delete(job.chatId);
    }
  }

  public abortAll(): void {
    const reason = new Error("Reply worker is stopping");
    reason.name = "AbortError";
    for (const run of this.activeRuns.values()) {
      run.controller.abort(reason);
    }
    this.activeRuns.clear();
  }

  public async renewLease(
    job: ClaimedReplyJob,
    workerId: string,
  ): Promise<boolean> {
    const result = await this.database.replyJob.updateMany({
      where: {
        id: job.id,
        revision: job.revision,
        status: ReplyJobStatus.PROCESSING,
        leaseOwner: workerId,
      },
      data: { lockedAt: this.now() },
    });
    return result.count === 1;
  }

  public async isCurrent(
    job: ClaimedReplyJob,
    workerId: string,
  ): Promise<boolean> {
    const state = await this.database.replyJob.findUnique({
      where: { id: job.id },
      select: { revision: true, status: true, leaseOwner: true },
    });
    return matchesReplyFence(state, job.revision, workerId);
  }

  public async complete(
    job: ClaimedReplyJob,
    workerId: string,
  ): Promise<boolean> {
    const result = await this.database.replyJob.updateMany({
      where: {
        id: job.id,
        revision: job.revision,
        status: ReplyJobStatus.PROCESSING,
        leaseOwner: workerId,
      },
      data: {
        status: ReplyJobStatus.COMPLETED,
        lockedAt: null,
        leaseOwner: null,
        lastErrorCode: null,
      },
    });
    return result.count === 1;
  }

  public async cancelClaim(
    job: ClaimedReplyJob,
    workerId: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.database.replyJob.updateMany({
      where: {
        id: job.id,
        revision: job.revision,
        status: ReplyJobStatus.PROCESSING,
        leaseOwner: workerId,
      },
      data: {
        status: ReplyJobStatus.CANCELED,
        lockedAt: null,
        leaseOwner: null,
        lastErrorCode: safeErrorCode(reason),
      },
    });
    return result.count === 1;
  }

  /** Defers without consuming an error attempt (for cooldown and shutdown). */
  public async defer(
    job: ClaimedReplyJob,
    workerId: string,
    dueAt: Date,
    reason: string,
  ): Promise<boolean> {
    const result = await this.database.replyJob.updateMany({
      where: {
        id: job.id,
        revision: job.revision,
        status: ReplyJobStatus.PROCESSING,
        leaseOwner: workerId,
      },
      data: {
        status: ReplyJobStatus.PENDING,
        dueAt,
        attempt: { decrement: 1 },
        lockedAt: null,
        leaseOwner: null,
        lastErrorCode: safeErrorCode(reason),
      },
    });
    return result.count === 1;
  }

  public async retry(
    job: ClaimedReplyJob,
    workerId: string,
    error: unknown,
    retryAfterMs?: number,
  ): Promise<boolean> {
    if (job.attempt >= this.maxAttempts) {
      return this.cancelClaim(job, workerId, errorCode(error));
    }

    const delayMs = Math.max(
      retryAfterMs ?? 0,
      computeRetryDelayMs(job.attempt, {
        baseMs: this.retryBaseMs,
        maximumMs: this.retryMaxMs,
        jitterRatio: this.retryJitterRatio,
        random: this.random,
      }),
    );
    const result = await this.database.replyJob.updateMany({
      where: {
        id: job.id,
        revision: job.revision,
        status: ReplyJobStatus.PROCESSING,
        leaseOwner: workerId,
      },
      data: {
        status: ReplyJobStatus.PENDING,
        dueAt: new Date(this.now().getTime() + delayMs),
        lockedAt: null,
        leaseOwner: null,
        lastErrorCode: errorCode(error),
      },
    });
    return result.count === 1;
  }

  private abortOlderLocalRun(chatId: string, revision: number): void {
    const active = this.activeRuns.get(chatId);
    if (active && active.revision < revision) {
      active.controller.abort(new SupersededReplyError());
      this.activeRuns.delete(chatId);
    }
  }

  private abortLocalRun(chatId: string): void {
    const active = this.activeRuns.get(chatId);
    if (active) {
      active.controller.abort(new SupersededReplyError());
      this.activeRuns.delete(chatId);
    }
  }
}

export function matchesReplyFence(
  state: ReplyFenceState | null,
  claimedRevision: number,
  workerId: string,
): boolean {
  return (
    state !== null &&
    state.revision === claimedRevision &&
    state.status === "PROCESSING" &&
    state.leaseOwner === workerId
  );
}

export function isLeaseExpired(
  lockedAt: Date | null,
  now: Date,
  leaseMs: number,
): boolean {
  return lockedAt === null || now.getTime() - lockedAt.getTime() >= leaseMs;
}

export function computeRetryDelayMs(
  attempt: number,
  options: RetryDelayOptions = {},
): number {
  const baseMs = positiveInteger(options.baseMs, DEFAULT_RETRY_BASE_MS);
  const maximumMs = positiveInteger(options.maximumMs, DEFAULT_RETRY_MAX_MS);
  const jitterRatio = nonNegativeNumber(
    options.jitterRatio,
    DEFAULT_RETRY_JITTER_RATIO,
  );
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const exponential = Math.min(maximumMs, baseMs * 2 ** exponent);
  const randomValue = Math.min(1, Math.max(0, random()));
  const jitter = Math.floor(exponential * jitterRatio * randomValue);
  return Math.min(maximumMs, exponential + jitter);
}

export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown_error";
  }

  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    errorCode?: unknown;
  };
  const code = candidate.code ?? candidate.errorCode ?? candidate.status;
  return safeErrorCode(
    typeof code === "string" || typeof code === "number"
      ? `${error.name}_${String(code)}`
      : error.name,
  );
}

function safeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return (normalized || "unknown_error").slice(0, 120);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}
