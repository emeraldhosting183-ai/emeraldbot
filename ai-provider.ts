import type { AiGenerationResult, AiProvider } from "../ai/ai-provider.js";
import { buildSystemInstructions } from "../ai/prompt.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { estimateCostUsd } from "../domain/cost.js";
import {
  evaluateReplyPolicy,
  type PolicyMessageKind,
} from "../domain/reply-policy.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { MessageDirection } from "../generated/prisma/enums.js";
import {
  SupersededReplyError,
  type ClaimedReplyJob,
} from "../queue/reply-queue.js";
import type { ReplyQueue } from "../queue/reply-queue.js";
import {
  TelegramApiError,
  type TelegramClient,
} from "../telegram/telegram-client.js";
import { isAbortError, randomInteger, sleep } from "../utils/async.js";
import { truncateText } from "../utils/text.js";
import type { AccessService } from "./access-service.js";
import type { BusinessConnectionService } from "./business-connection-service.js";
import type { ChatService } from "./chat-service.js";
import type { SettingsService } from "./settings-service.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_POLL_MS = 500;
const TELEGRAM_REPLY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TYPING_REFRESH_MS = 4_000;

export interface ReplyWorkerOptions {
  database: PrismaClient;
  queue: ReplyQueue;
  telegram: TelegramClient;
  ai: AiProvider;
  businessConnections: BusinessConnectionService;
  settings: SettingsService;
  access: AccessService;
  chats: ChatService;
  concurrency?: number;
  pollMs?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  now?: () => Date;
}

interface LoadedContext {
  chat: {
    id: string;
    businessConnectionId: string;
    telegramChatId: bigint;
    type: string;
    manualMode: boolean;
    customStyle: string | null;
    lastOutboundAt: Date | null;
  };
  connection: {
    id: string;
    isEnabled: boolean;
    canReply: boolean;
  };
  sourceMessage: {
    telegramMessageId: bigint;
    kind: PolicyMessageKind;
    text: string | null;
    sentAt: Date;
  };
  settings: {
    autoReplyEnabled: boolean;
    allowlistOnly: boolean;
    globalStyle: string;
    minDelayMs: number;
    maxDelayMs: number;
    maxReplyChars: number;
    historyLimit: number;
    scheduleEnabled: boolean;
    scheduleStartMinute: number;
    scheduleEndMinute: number;
    scheduleDays: string;
    timezone: string;
    ignoreOneWord: boolean;
    ignoreReactions: boolean;
    ignoreStickers: boolean;
    ignoreServiceMessages: boolean;
    unsupportedAttachmentPolicy: "SKIP" | "NEUTRAL";
    unsupportedAttachmentReply: string;
    cooldownSeconds: number;
  };
  rules: { allowed: boolean; denied: boolean };
  policy: ReturnType<typeof evaluateReplyPolicy>;
}

/** Runs four independent claim loops; PostgreSQL lease fencing makes replicas safe. */
export class ReplyWorker {
  private readonly database: PrismaClient;
  private readonly queue: ReplyQueue;
  private readonly telegram: TelegramClient;
  private readonly ai: AiProvider;
  private readonly businessConnections: BusinessConnectionService;
  private readonly settings: SettingsService;
  private readonly access: AccessService;
  private readonly chats: ChatService;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly inputCostPerMillion: number;
  private readonly outputCostPerMillion: number;
  private readonly now: () => Date;
  private workerTasks: Promise<void>[] = [];
  private stopController: AbortController | null = null;

  public constructor(options: ReplyWorkerOptions) {
    this.database = options.database;
    this.queue = options.queue;
    this.telegram = options.telegram;
    this.ai = options.ai;
    this.businessConnections = options.businessConnections;
    this.settings = options.settings;
    this.access = options.access;
    this.chats = options.chats;
    this.concurrency = boundedInteger(options.concurrency, DEFAULT_CONCURRENCY, 1, 32);
    this.pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, 50, 60_000);
    const defaults = defaultPrices(options.ai);
    this.inputCostPerMillion =
      options.inputCostPerMillion ??
      env.AI_INPUT_COST_PER_MILLION ??
      defaults.inputPerMillion;
    this.outputCostPerMillion =
      options.outputCostPerMillion ??
      env.AI_OUTPUT_COST_PER_MILLION ??
      defaults.outputPerMillion;
    this.now = options.now ?? (() => new Date());
  }

  /** Starts the configured four loops without blocking application startup. */
  public start(externalSignal?: AbortSignal): void {
    if (this.stopController !== null) {
      return;
    }

    this.stopController = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([this.stopController.signal, externalSignal])
      : this.stopController.signal;
    this.workerTasks = Array.from({ length: this.concurrency }, (_, slot) =>
      this.runLoop(this.queue.createWorkerId(slot), signal),
    );
  }

  /** Stops claiming, aborts local generations, and waits for all loops to settle. */
  public async stop(): Promise<void> {
    const controller = this.stopController;
    if (!controller) {
      return;
    }

    controller.abort(new Error("Reply worker is stopping"));
    this.queue.abortAll();
    await Promise.allSettled(this.workerTasks);
    this.workerTasks = [];
    this.stopController = null;
  }

  /** Processes at most one job; useful for probes and deterministic integration tests. */
  public async runOnce(workerId = this.queue.createWorkerId(0)): Promise<boolean> {
    const job = await this.queue.claimNext(workerId);
    if (!job) {
      return false;
    }

    const runController = this.queue.registerLocalRun(job);
    const heartbeatController = new AbortController();
    const heartbeatSignal = AbortSignal.any([
      runController.signal,
      heartbeatController.signal,
    ]);
    const heartbeatTask = this.keepLeaseAlive(
      job,
      workerId,
      runController,
      heartbeatSignal,
    );

    try {
      await this.processJob(job, workerId, runController.signal);
    } catch (error) {
      if (isAbortError(error) || error instanceof SupersededReplyError) {
        // If this revision is still ours, the abort is a shutdown rather than a
        // superseding update. Return it to PostgreSQL for another instance.
        if (await this.queue.isCurrent(job, workerId)) {
          await this.queue.defer(
            job,
            workerId,
            this.now(),
            "worker_aborted",
          );
        }
      } else if (isRetryableError(error)) {
        await this.queue.retry(job, workerId, error, retryAfterMs(error));
      } else {
        await this.queue.cancelClaim(job, workerId, errorName(error));
      }

      logger.warn(
        {
          err: error,
          jobId: job.id,
          chatId: job.chatId,
          revision: job.revision,
          attempt: job.attempt,
        },
        "Reply job did not complete",
      );
    } finally {
      heartbeatController.abort();
      await heartbeatTask;
      this.queue.releaseLocalRun(job, runController);
    }

    return true;
  }

  private async runLoop(workerId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const processed = await this.runOnce(workerId);
        if (!processed) {
          await sleep(this.pollMs, signal);
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return;
        }

        logger.error({ err: error, workerId }, "Reply queue loop failed");
        try {
          await sleep(this.pollMs, signal);
        } catch (sleepError) {
          if (isAbortError(sleepError)) {
            return;
          }
          throw sleepError;
        }
      }
    }
  }

  private async processJob(
    job: ClaimedReplyJob,
    workerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const initial = await this.loadContext(job, signal, true);
    if (!initial) {
      await this.queue.cancelClaim(job, workerId, "missing_job_context");
      return;
    }
    if (!(await this.acceptPolicy(job, workerId, initial))) {
      return;
    }

    const cooldownUntil = getCooldownUntil(initial);
    if (cooldownUntil && cooldownUntil.getTime() > this.now().getTime()) {
      await this.queue.defer(job, workerId, cooldownUntil, "cooldown");
      return;
    }

    if (
      this.now().getTime() - initial.sourceMessage.sentAt.getTime() >=
      TELEGRAM_REPLY_WINDOW_MS
    ) {
      await this.queue.cancelClaim(job, workerId, "reply_window_expired");
      return;
    }

    const typingController = new AbortController();
    const typingSignal = AbortSignal.any([signal, typingController.signal]);
    const typingTask = this.keepTyping(initial, typingSignal);

    try {
      const minimumDelay = Math.max(0, initial.settings.minDelayMs);
      const maximumDelay = Math.max(minimumDelay, initial.settings.maxDelayMs);
      await sleep(randomInteger(minimumDelay, maximumDelay), signal);
      await this.assertCurrent(job, workerId);

      const beforeGeneration = await this.loadContext(job, signal, false);
      if (!beforeGeneration) {
        await this.queue.cancelClaim(job, workerId, "missing_job_context");
        return;
      }
      if (!(await this.acceptPolicy(job, workerId, beforeGeneration))) {
        return;
      }

      const maximumCharacters = clamp(
        beforeGeneration.settings.maxReplyChars,
        1,
        4_096,
      );
      const historyLimit = clamp(
        beforeGeneration.settings.historyLimit,
        1,
        30,
      );
      const history = await this.chats.getHistory(job.chatId, historyLimit);

      let replyText: string;
      if (
        beforeGeneration.sourceMessage.text === null &&
        (beforeGeneration.sourceMessage.kind !== "UNSUPPORTED" ||
          beforeGeneration.settings.unsupportedAttachmentPolicy === "NEUTRAL")
      ) {
        replyText = beforeGeneration.settings.unsupportedAttachmentReply;
      } else {
        if (history.length === 0) {
          await this.queue.cancelClaim(job, workerId, "empty_history");
          return;
        }

        const result = await this.ai.generateReply({
          instructions: buildSystemInstructions({
            globalStyle: beforeGeneration.settings.globalStyle,
            chatStyle: beforeGeneration.chat.customStyle,
            maximumCharacters,
          }),
          messages: history,
          maxOutputTokens: clamp(Math.ceil(maximumCharacters / 2), 32, 4_096),
          signal,
        });
        await this.storeUsage(job.chatId, result);
        replyText = result.text;
      }

      const finalText = truncateText(replyText, maximumCharacters).trim();
      if (!finalText) {
        await this.queue.cancelClaim(job, workerId, "empty_reply");
        return;
      }

      await this.assertCurrent(job, workerId);
      const beforeSend = await this.loadContext(job, signal, false);
      if (!beforeSend) {
        await this.queue.cancelClaim(job, workerId, "missing_job_context");
        return;
      }
      if (!(await this.acceptPolicy(job, workerId, beforeSend))) {
        return;
      }

      const finalCooldown = getCooldownUntil(beforeSend);
      if (finalCooldown && finalCooldown.getTime() > this.now().getTime()) {
        await this.queue.defer(job, workerId, finalCooldown, "cooldown");
        return;
      }

      // This is the final database fence. A newer revision or reclaimed lease
      // must never send the draft generated by this worker.
      await this.assertCurrent(job, workerId);
      const sentMessage = await this.telegram.sendMessage(
        {
          business_connection_id: beforeSend.chat.businessConnectionId,
          chat_id: beforeSend.chat.telegramChatId.toString(),
          text: finalText,
          reply_parameters: {
            message_id: Number(beforeSend.sourceMessage.telegramMessageId),
            allow_sending_without_reply: true,
          },
        },
        signal,
      );

      // Never retry the Telegram send after it returned success. State writes
      // are best effort from this point to avoid duplicate external messages.
      try {
        const completed = await this.queue.complete(job, workerId);
        if (!completed) {
          logger.warn(
            { jobId: job.id, revision: job.revision },
            "Telegram reply was sent after its queue fence changed",
          );
        }
      } catch (error) {
        logger.error(
          { err: error, jobId: job.id },
          "Telegram reply was sent but queue completion could not be persisted",
        );
        try {
          await this.queue.cancelClaim(
            job,
            workerId,
            "send_committed_state_unknown",
          );
        } catch (cancelError) {
          logger.error(
            { err: cancelError, jobId: job.id },
            "Unable to fence a reply whose send was already committed",
          );
        }
      }

      try {
        await this.chats.storeBotReply(job.chatId, sentMessage);
      } catch (error) {
        logger.error(
          { err: error, jobId: job.id },
          "Telegram reply was sent but message history could not be persisted",
        );
      }
    } finally {
      typingController.abort();
      await typingTask;
    }
  }

  private async loadContext(
    job: ClaimedReplyJob,
    signal: AbortSignal,
    refreshRights: boolean,
  ): Promise<LoadedContext | null> {
    const chat = await this.database.chat.findUnique({
      where: { id: job.chatId },
      select: {
        id: true,
        businessConnectionId: true,
        telegramChatId: true,
        type: true,
        manualMode: true,
        customStyle: true,
        lastOutboundAt: true,
      },
    });
    if (!chat) {
      return null;
    }

    const sourceWhere =
      job.sourceMessageId === null
        ? {
            chatId: job.chatId,
            direction: MessageDirection.INBOUND,
            deletedAt: null,
          }
        : {
            chatId: job.chatId,
            telegramMessageId: job.sourceMessageId,
            direction: MessageDirection.INBOUND,
            deletedAt: null,
          };
    const [connection, settings, rules, sourceMessage] = await Promise.all([
      refreshRights
        ? this.businessConnections.refresh(chat.businessConnectionId, signal)
        : this.database.businessConnection.findUnique({
            where: { id: chat.businessConnectionId },
          }),
      this.settings.get(),
      this.access.getRules(chat.businessConnectionId, chat.telegramChatId),
      this.database.message.findFirst({
        where: sourceWhere,
        select: {
          telegramMessageId: true,
          kind: true,
          text: true,
          sentAt: true,
        },
        orderBy: [{ sentAt: "desc" }, { telegramMessageId: "desc" }],
      }),
    ]);
    if (!connection || !sourceMessage) {
      return null;
    }

    const policy = evaluateReplyPolicy({
      settings: {
        autoReplyEnabled: settings.autoReplyEnabled,
        allowlistOnly: settings.allowlistOnly,
        scheduleEnabled: settings.scheduleEnabled,
        scheduleStartMinute: settings.scheduleStartMinute,
        scheduleEndMinute: settings.scheduleEndMinute,
        scheduleDays: settings.scheduleDays,
        timezone: settings.timezone,
        ignoreOneWord: settings.ignoreOneWord,
        ignoreReactions: settings.ignoreReactions,
        ignoreStickers: settings.ignoreStickers,
        ignoreServiceMessages: settings.ignoreServiceMessages,
        unsupportedAttachmentPolicy: settings.unsupportedAttachmentPolicy,
      },
      connectionEnabled: connection.isEnabled,
      connectionCanReply: connection.canReply,
      manualMode: chat.manualMode,
      hasAllowRule: rules.allowed,
      hasDenyRule: rules.denied,
      kind: sourceMessage.kind,
      text: sourceMessage.text,
      now: this.now(),
    });

    return {
      chat,
      connection,
      sourceMessage: {
        ...sourceMessage,
        kind: sourceMessage.kind,
      },
      settings,
      rules,
      policy,
    };
  }

  private async acceptPolicy(
    job: ClaimedReplyJob,
    workerId: string,
    context: LoadedContext,
  ): Promise<boolean> {
    if (context.chat.type !== "private") {
      await this.queue.cancelClaim(job, workerId, "non_private_chat");
      return false;
    }
    if (!context.policy.allowed) {
      await this.queue.cancelClaim(
        job,
        workerId,
        `policy_${context.policy.reason}`,
      );
      return false;
    }
    return true;
  }

  private async assertCurrent(
    job: ClaimedReplyJob,
    workerId: string,
  ): Promise<void> {
    if (!(await this.queue.isCurrent(job, workerId))) {
      throw new SupersededReplyError();
    }
  }

  private async keepLeaseAlive(
    job: ClaimedReplyJob,
    workerId: string,
    runController: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        await sleep(this.queue.heartbeatIntervalMs, signal);
        const renewed = await this.queue.renewLease(job, workerId);
        if (!renewed) {
          runController.abort(new SupersededReplyError());
          return;
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return;
      }
      logger.error(
        { err: error, jobId: job.id },
        "Reply lease heartbeat failed; aborting generation",
      );
      runController.abort(new SupersededReplyError());
    }
  }

  private async keepTyping(
    context: LoadedContext,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.telegram.sendChatAction(
            {
              business_connection_id: context.chat.businessConnectionId,
              chat_id: context.chat.telegramChatId.toString(),
              action: "typing",
            },
            signal,
          );
        } catch (error) {
          if (isAbortError(error) || signal.aborted) {
            return;
          }
          logger.debug(
            { err: error, chatId: context.chat.id },
            "Telegram typing indicator failed",
          );
        }
        await sleep(TYPING_REFRESH_MS, signal);
      }
    } catch (error) {
      if (!isAbortError(error) && !signal.aborted) {
        logger.debug(
          { err: error, chatId: context.chat.id },
          "Telegram typing loop stopped unexpectedly",
        );
      }
    }
  }

  private async storeUsage(
    chatId: string,
    result: AiGenerationResult,
  ): Promise<void> {
    const estimatedCostUsd = estimateCostUsd(result, {
      inputPerMillion: this.inputCostPerMillion,
      outputPerMillion: this.outputCostPerMillion,
    });
    await this.database.usageRecord.create({
      data: {
        chatId,
        provider: result.provider,
        model: result.model,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        estimatedCostUsd,
        latencyMs: result.latencyMs,
      },
    });
  }
}

function getCooldownUntil(context: LoadedContext): Date | null {
  if (!context.chat.lastOutboundAt || context.settings.cooldownSeconds <= 0) {
    return null;
  }
  return new Date(
    context.chat.lastOutboundAt.getTime() +
      context.settings.cooldownSeconds * 1_000,
  );
}

function defaultPrices(provider: AiProvider): {
  inputPerMillion: number;
  outputPerMillion: number;
} {
  if (provider.provider === "OPENAI" && provider.model === "gpt-5.4") {
    return { inputPerMillion: 2.5, outputPerMillion: 15 };
  }
  return { inputPerMillion: 0, outputPerMillion: 0 };
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TelegramApiError) {
    const status = error.errorCode ?? error.httpStatus ?? 0;
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & { code?: unknown; status?: unknown };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.code === "number"
        ? candidate.code
        : Number(candidate.code);
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return true;
  }
  if (
    typeof candidate.code === "string" &&
    ["P1001", "P1002", "P1008", "P1017", "P2034"].includes(candidate.code)
  ) {
    return true;
  }
  return error instanceof TypeError;
}

function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1_000;
  }
  const candidate = error as { retryAfter?: unknown; retry_after?: unknown };
  const seconds = candidate.retryAfter ?? candidate.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value !== undefined && Number.isInteger(value)
    ? clamp(value, minimum, maximum)
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
