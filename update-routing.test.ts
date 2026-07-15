import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { sleep } from "../utils/async.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

export async function connectDatabase(): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      logger.info({ dependency: "postgresql" }, "Database connection established");
      return;
    } catch (error) {
      lastError = error;
      logger.warn(
        { dependency: "postgresql", attempt, err: error },
        "Database connection attempt failed",
      );
      if (attempt < 5) {
        await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to connect to PostgreSQL");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
