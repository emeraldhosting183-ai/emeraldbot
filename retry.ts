import { createAiProvider } from "../src/ai/create-provider.js";
import { env } from "../src/config/env.js";
import { logger } from "../src/config/logger.js";
import { prisma } from "../src/db/prisma.js";
import {
  HealthService,
  isHealthy,
} from "../src/health/health-service.js";
import { TelegramClient } from "../src/telegram/telegram-client.js";

const HEALTH_PROBE_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const aiProvider = createAiProvider(env);
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
        await aiProvider.checkConnection(signal);
      },
    },
  });

  try {
    const report = await healthService.check({ forceRefresh: true });
    if (isHealthy(report)) {
      logger.info({ health: report }, "All external connections are healthy");
      return;
    }

    logger.error(
      { health: report },
      "One or more external connections are unavailable",
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  logger.error({ err: error }, "Connection check failed");
  process.exitCode = 1;
});
