import type { PrismaClient } from "../generated/prisma/client.js";
import type { TelegramClient } from "../telegram/telegram-client.js";
import type { BusinessConnection } from "../telegram/types.js";

export class BusinessConnectionService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly telegram: TelegramClient,
  ) {}

  public async store(connection: BusinessConnection) {
    const rights = sanitizeJson(connection.rights ?? {});
    return this.database.businessConnection.upsert({
      where: { id: connection.id },
      create: {
        id: connection.id,
        ownerTelegramId: BigInt(connection.user.id),
        ownerChatId: BigInt(connection.user_chat_id),
        ownerUsername: connection.user.username ?? null,
        ownerFirstName: connection.user.first_name ?? null,
        ownerLastName: connection.user.last_name ?? null,
        connectedAt: new Date(connection.date * 1_000),
        isEnabled: connection.is_enabled,
        canReply: connection.rights?.can_reply === true,
        rights,
        lastCheckedAt: new Date(),
      },
      update: {
        ownerTelegramId: BigInt(connection.user.id),
        ownerChatId: BigInt(connection.user_chat_id),
        ownerUsername: connection.user.username ?? null,
        ownerFirstName: connection.user.first_name ?? null,
        ownerLastName: connection.user.last_name ?? null,
        isEnabled: connection.is_enabled,
        canReply: connection.rights?.can_reply === true,
        rights,
        lastCheckedAt: new Date(),
      },
    });
  }

  public async getOrFetch(connectionId: string, signal?: AbortSignal) {
    const existing = await this.database.businessConnection.findUnique({
      where: { id: connectionId },
    });
    if (existing) {
      return existing;
    }
    return this.refresh(connectionId, signal);
  }

  public async refresh(connectionId: string, signal?: AbortSignal) {
    const connection = await this.telegram.getBusinessConnection(
      connectionId,
      signal,
    );
    return this.store(connection);
  }

  public async cancelJobsForDisabledConnection(connectionId: string): Promise<void> {
    await this.database.replyJob.updateMany({
      where: {
        chat: { businessConnectionId: connectionId },
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: {
        revision: { increment: 1 },
        status: "CANCELED",
        lockedAt: null,
        leaseOwner: null,
      },
    });
  }
}

function sanitizeJson(value: object): object {
  return JSON.parse(JSON.stringify(value)) as object;
}
