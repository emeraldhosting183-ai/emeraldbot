import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express } from "express";

import { createAiProvider } from "./ai/create-provider.js";
import { OwnerCommandService } from "./commands/owner-command-service.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import {
  connectDatabase,
  disconnectDatabase,
  prisma,
} from "./db/prisma.js";
import { HealthService } from "./health/health-service.js";
import { createApp } from "./http/create-app.js";
import { ReplyQueue } from "./queue/reply-queue.js";
import { AccessService } from "./services/access-service.js";
import { BusinessConnectionService } from "./services/business-connection-service.js";
import { ChatService } from "./services/chat-service.js";
import { ReplyWorker } from "./services/reply-worker.js";
import { SettingsService } from "./services/settings-service.js";
import { UpdateDeduplicator } from "./services/update-deduplicator.js";
import { UpdateProcessor } from "./services/update-processor.js";
import { TelegramClient } from "./telegram/telegram-client.js";

const STARTUP_TELEGRAM_TIMEOUT_MS = 15_000;
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const HTTP_SHUTDOWN_TIMEOUT_MS = 25_000;

export interface ApplicationRuntime {
  readonly app: Express;
  readonly replyWorker: ReplyWorker;
}

/** Central composition root; constructors and infrastructure wiring live here. */
export async function createApplicationRuntime(): Promise<ApplicationRuntime> {
  await connectDatabase();

  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const bot = await telegram.getMe(
    AbortSignal.timeout(STARTUP_TELEGRAM_TIMEOUT_MS),
  );
  const ai = createAiProvider(env);
  const replyQueue = new ReplyQueue(prisma);
  const settings = new SettingsService(prisma);
  const access = new AccessService(prisma);
  const chats = new ChatService(prisma);
  const businessConnections = new BusinessConnectionService(
    prisma,
    telegram,
  );
  const deduplicator = new UpdateDeduplicator(prisma);
  const ownerCommands = new OwnerCommandService(
    prisma,
    telegram,
    settings,
    chats,
    access,
    replyQueue,
    env.TELEGRAM_OWNER_ID_BIGINT,
  );
  const updateProcessor = new UpdateProcessor({
    deduplicator,
    businessConnections,
    chats,
    access,
    settings,
    replyQueue,
    ownerCommands,
    botId: bot.id,
  });
  const replyWorker = new ReplyWorker({
    database: prisma,
    queue: replyQueue,
    telegram,
    ai,
    businessConnections,
    settings,
    access,
    chats,
    pollMs: env.WORKER_POLL_MS,
  });
  const healthService = new HealthService({
    cacheTtlMs: env.HEALTH_CACHE_TTL_MS,
    probeTimeoutMs: HEALTH_PROBE_TIMEOUT_MS,
    logger,
    probes: {
      postgresql: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
      telegram: async (signal) => {
        await telegram.getMe(signal);
      },
      ai: async (signal) => {
        await ai.checkConnection(signal);
      },
    },
  });
  const app = createApp({
    healthService,
    updateProcessor,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    logger,
  });

  return { app, replyWorker };
}

export async function bootstrap(): Promise<void> {
  let runtime: ApplicationRuntime | undefined;
  let server: Server | undefined;

  try {
    runtime = await createApplicationRuntime();
    server = await listen(runtime.app);
    runtime.replyWorker.start();

    const requestShutdown = createShutdownHandler(runtime, server);
    process.once("SIGTERM", () => {
      void requestShutdown("SIGTERM", 0);
    });
    process.once("SIGINT", () => {
      void requestShutdown("SIGINT", 0);
    });
    process.once("uncaughtException", (error) => {
      void requestShutdown("uncaughtException", 1, error);
    });
    process.once("unhandledRejection", (error) => {
      void requestShutdown("unhandledRejection", 1, error);
    });
    server.on("error", (error) => {
      void requestShutdown("httpServerError", 1, error);
    });

    logger.info(
      {
        host: "0.0.0.0",
        port: env.PORT,
        aiProvider: env.AI_PROVIDER,
        aiModel: aiModelLabel(),
      },
      "Application is ready",
    );
  } catch (error) {
    logger.fatal({ err: error }, "Application startup failed");
    process.exitCode = 1;
    await stopApplication(runtime, server);
  }
}

function listen(app: Express): Promise<Server> {
  const server = createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return new Promise<Server>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(env.PORT, "0.0.0.0", () => {
      server.off("error", onError);
      resolvePromise(server);
    });
  });
}

function createShutdownHandler(
  runtime: ApplicationRuntime,
  server: Server,
): (
  reason: string,
  exitCode: number,
  error?: unknown,
) => Promise<void> {
  let shutdown: Promise<void> | undefined;

  return (reason, exitCode, error) => {
    if (shutdown !== undefined) {
      return shutdown;
    }

    if (error === undefined) {
      logger.info({ reason }, "Graceful shutdown started");
    } else {
      logger.fatal({ reason, err: error }, "Fatal process error");
    }
    process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);

    shutdown = stopApplication(runtime, server).then(() => {
      logger.info({ reason }, "Graceful shutdown completed");
    });
    return shutdown;
  };
}

async function stopApplication(
  runtime: ApplicationRuntime | undefined,
  server: Server | undefined,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (server !== undefined) {
    tasks.push(closeHttpServer(server));
  }
  if (runtime !== undefined) {
    tasks.push(runtime.replyWorker.stop());
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason }, "Shutdown task failed");
      process.exitCode = 1;
    }
  }

  try {
    await disconnectDatabase();
  } catch (error) {
    logger.error({ err: error }, "Database disconnect failed");
    process.exitCode = 1;
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      logger.warn("HTTP shutdown timed out; closing remaining connections");
      server.closeAllConnections();
      finish();
    }, HTTP_SHUTDOWN_TIMEOUT_MS);

    server.close(finish);
    server.closeIdleConnections();
  });
}

function aiModelLabel(): string {
  return env.AI_PROVIDER === "gemini" ? env.GEMINI_MODEL : env.OPENAI_MODEL;
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return (
    entryPoint !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPoint)).href
  );
}

if (isMainModule()) {
  void bootstrap();
}
