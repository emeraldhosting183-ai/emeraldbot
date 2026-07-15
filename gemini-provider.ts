import type { PrismaClient } from "../generated/prisma/client.js";
import { ProcessedUpdateStatus } from "../generated/prisma/enums.js";

const STALE_CLAIM_MS = 5 * 60 * 1_000;

export class UpdateDeduplicator {
  public constructor(private readonly database: PrismaClient) {}

  public async claim(updateId: bigint, updateType: string): Promise<boolean> {
    try {
      await this.database.processedUpdate.create({
        data: {
          updateId,
          updateType,
          status: ProcessedUpdateStatus.PROCESSING,
        },
      });
      return true;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
    const result = await this.database.processedUpdate.updateMany({
      where: {
        updateId,
        OR: [
          { status: ProcessedUpdateStatus.FAILED },
          {
            status: ProcessedUpdateStatus.PROCESSING,
            claimedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        status: ProcessedUpdateStatus.PROCESSING,
        updateType,
        attempt: { increment: 1 },
        claimedAt: new Date(),
        processedAt: null,
        errorCode: null,
      },
    });
    return result.count === 1;
  }

  public async complete(updateId: bigint): Promise<void> {
    await this.database.processedUpdate.updateMany({
      where: {
        updateId,
        status: ProcessedUpdateStatus.PROCESSING,
      },
      data: {
        status: ProcessedUpdateStatus.COMPLETED,
        processedAt: new Date(),
        errorCode: null,
      },
    });
  }

  public async fail(updateId: bigint, errorCode: string): Promise<void> {
    await this.database.processedUpdate.updateMany({
      where: { updateId },
      data: {
        status: ProcessedUpdateStatus.FAILED,
        processedAt: new Date(),
        errorCode: errorCode.slice(0, 100),
      },
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
