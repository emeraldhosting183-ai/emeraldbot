import type { ConversationMessage } from "../ai/ai-provider.js";
import {
  detectMessageKind,
  extractMessageText,
  sourceToDirection,
} from "../domain/message.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  MessageDirection,
  MessageStatus,
} from "../generated/prisma/enums.js";
import type { BusinessMessageSource } from "../telegram/classify.js";
import type {
  BusinessConnection,
  TelegramMessage,
} from "../telegram/types.js";

export class ChatService {
  public constructor(private readonly database: PrismaClient) {}

  public async upsertChat(
    connection: BusinessConnection,
    message: TelegramMessage,
  ) {
    const privatePeerId = message.chat.type === "private" ? message.chat.id : undefined;
    return this.database.chat.upsert({
      where: {
        businessConnectionId_telegramChatId: {
          businessConnectionId: connection.id,
          telegramChatId: BigInt(message.chat.id),
        },
      },
      create: {
        businessConnectionId: connection.id,
        telegramChatId: BigInt(message.chat.id),
        type: message.chat.type,
        username: message.chat.username ?? null,
        title: message.chat.title ?? null,
        peerTelegramId: privatePeerId === undefined ? null : BigInt(privatePeerId),
        peerUsername: message.chat.username ?? null,
        peerFirstName: message.chat.first_name ?? null,
        peerLastName: message.chat.last_name ?? null,
      },
      update: {
        type: message.chat.type,
        username: message.chat.username ?? null,
        title: message.chat.title ?? null,
        peerTelegramId: privatePeerId === undefined ? null : BigInt(privatePeerId),
        peerUsername: message.chat.username ?? null,
        peerFirstName: message.chat.first_name ?? null,
        peerLastName: message.chat.last_name ?? null,
      },
    });
  }

  public async storeMessage(options: {
    chatId: string;
    updateId?: bigint;
    message: TelegramMessage;
    source: BusinessMessageSource;
    edited: boolean;
  }) {
    const direction = sourceToDirection(options.source);
    const text = extractMessageText(options.message);
    const kind = detectMessageKind(options.message);
    const sentAt = new Date(options.message.date * 1_000);
    const editedAt = options.message.edit_date
      ? new Date(options.message.edit_date * 1_000)
      : options.edited
        ? new Date()
        : null;

    const record = await this.database.message.upsert({
      where: {
        chatId_telegramMessageId: {
          chatId: options.chatId,
          telegramMessageId: BigInt(options.message.message_id),
        },
      },
      create: {
        chatId: options.chatId,
        telegramMessageId: BigInt(options.message.message_id),
        lastUpdateId: options.updateId ?? null,
        senderTelegramId:
          options.message.from?.id === undefined
            ? null
            : BigInt(options.message.from.id),
        direction,
        kind,
        text,
        isFromBot:
          options.message.from?.is_bot === true ||
          options.message.sender_business_bot !== undefined,
        isOffline: options.message.is_from_offline === true,
        sentAt,
        editedAt,
        status: options.edited ? MessageStatus.EDITED : MessageStatus.RECEIVED,
      },
      update: {
        lastUpdateId: options.updateId ?? null,
        senderTelegramId:
          options.message.from?.id === undefined
            ? null
            : BigInt(options.message.from.id),
        direction,
        kind,
        text,
        isFromBot:
          options.message.from?.is_bot === true ||
          options.message.sender_business_bot !== undefined,
        isOffline: options.message.is_from_offline === true,
        editedAt,
        deletedAt: null,
        status: options.edited ? MessageStatus.EDITED : MessageStatus.RECEIVED,
      },
    });

    if (direction === MessageDirection.INBOUND) {
      await this.database.chat.update({
        where: { id: options.chatId },
        data: { lastInboundAt: sentAt },
      });
    } else if (
      direction === MessageDirection.OWNER_OUTBOUND ||
      direction === MessageDirection.BOT_OUTBOUND
    ) {
      await this.database.chat.update({
        where: { id: options.chatId },
        data: { lastOutboundAt: sentAt },
      });
    }
    return record;
  }

  public async storeBotReply(chatId: string, message: TelegramMessage) {
    return this.storeMessage({
      chatId,
      message,
      source: "this_bot",
      edited: false,
    });
  }

  public async markDeleted(
    businessConnectionId: string,
    telegramChatId: bigint,
    telegramMessageIds: readonly bigint[],
  ) {
    const chat = await this.database.chat.findUnique({
      where: {
        businessConnectionId_telegramChatId: {
          businessConnectionId,
          telegramChatId,
        },
      },
      select: { id: true },
    });
    if (!chat) {
      return null;
    }
    await this.database.message.updateMany({
      where: {
        chatId: chat.id,
        telegramMessageId: { in: [...telegramMessageIds] },
      },
      data: {
        deletedAt: new Date(),
        status: MessageStatus.DELETED,
        text: null,
      },
    });
    return chat;
  }

  public async getHistory(
    chatId: string,
    limit: number,
  ): Promise<ConversationMessage[]> {
    const messages = await this.database.message.findMany({
      where: {
        chatId,
        deletedAt: null,
        text: { not: null },
        direction: {
          in: [
            MessageDirection.INBOUND,
            MessageDirection.OWNER_OUTBOUND,
            MessageDirection.BOT_OUTBOUND,
          ],
        },
      },
      select: { direction: true, text: true },
      orderBy: [{ sentAt: "desc" }, { telegramMessageId: "desc" }],
      take: limit,
    });

    return messages.reverse().flatMap((message) =>
      message.text
        ? [
            {
              role:
                message.direction === MessageDirection.INBOUND
                  ? ("user" as const)
                  : ("assistant" as const),
              text: message.text,
            },
          ]
        : [],
    );
  }

  public findByTelegramId(
    telegramChatId: bigint,
    businessConnectionId?: string,
  ) {
    return this.database.chat.findMany({
      where: {
        telegramChatId,
        ...(businessConnectionId ? { businessConnectionId } : {}),
      },
      include: { businessConnection: true },
      take: 3,
    });
  }

  public async clearHistory(chatId: string): Promise<void> {
    await this.database.$transaction([
      this.database.message.deleteMany({ where: { chatId } }),
      this.database.usageRecord.deleteMany({ where: { chatId } }),
      this.database.replyJob.deleteMany({ where: { chatId } }),
    ]);
  }

  public async setManualMode(chatId: string, manualMode: boolean): Promise<void> {
    await this.database.chat.update({
      where: { id: chatId },
      data: { manualMode },
    });
  }

  public async setStyle(chatId: string, customStyle: string | null): Promise<void> {
    await this.database.chat.update({
      where: { id: chatId },
      data: { customStyle },
    });
  }
}
