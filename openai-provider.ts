import type { OwnerCommandService } from "../commands/owner-command-service.js";
import {
  detectMessageKind,
  extractMessageText,
} from "../domain/message.js";
import {
  evaluateReplyPolicy,
  type PolicyMessageKind,
} from "../domain/reply-policy.js";
import type { ReplyQueue } from "../queue/reply-queue.js";
import {
  classifyBusinessMessage,
  type BusinessMessageSource,
} from "../telegram/classify.js";
import type {
  BusinessConnection,
  TelegramMessage,
  TelegramUpdate,
} from "../telegram/types.js";
import type { AccessService } from "./access-service.js";
import type { BusinessConnectionService } from "./business-connection-service.js";
import type { ChatService } from "./chat-service.js";
import type { SettingsService } from "./settings-service.js";
import type { UpdateDeduplicator } from "./update-deduplicator.js";

export type RoutedUpdateType =
  | "message"
  | "business_connection"
  | "business_message"
  | "edited_business_message"
  | "deleted_business_messages"
  | "unsupported"
  | "invalid";

export type UpdateProcessingStatus = "processed" | "duplicate";

export interface UpdateProcessingResult {
  status: UpdateProcessingStatus;
  updateType: RoutedUpdateType;
}

export type UpdateDeduplicatorPort = Pick<
  UpdateDeduplicator,
  "claim" | "complete" | "fail"
>;
export type BusinessConnectionPort = Pick<
  BusinessConnectionService,
  "store" | "getOrFetch" | "cancelJobsForDisabledConnection"
>;
export type ChatPort = Pick<
  ChatService,
  "upsertChat" | "storeMessage" | "markDeleted"
>;
export type AccessPort = Pick<AccessService, "getRules">;
export type SettingsPort = Pick<SettingsService, "get">;
export type ReplyQueuePort = Pick<ReplyQueue, "schedule" | "cancel">;
export type OwnerCommandPort = Pick<OwnerCommandService, "handle">;

type StoredBusinessConnection = Awaited<
  ReturnType<BusinessConnectionService["getOrFetch"]>
>;

export interface UpdateProcessorDependencies {
  deduplicator: UpdateDeduplicatorPort;
  businessConnections: BusinessConnectionPort;
  chats: ChatPort;
  access: AccessPort;
  settings: SettingsPort;
  replyQueue: ReplyQueuePort;
  ownerCommands: OwnerCommandPort;
  botId: number;
}

/** Routes already authenticated Telegram webhook updates. */
export class UpdateProcessor {
  private readonly deduplicator: UpdateDeduplicatorPort;
  private readonly businessConnections: BusinessConnectionPort;
  private readonly chats: ChatPort;
  private readonly access: AccessPort;
  private readonly settings: SettingsPort;
  private readonly replyQueue: ReplyQueuePort;
  private readonly ownerCommands: OwnerCommandPort;
  private readonly botId: number;

  public constructor(dependencies: UpdateProcessorDependencies) {
    if (!Number.isSafeInteger(dependencies.botId) || dependencies.botId <= 0) {
      throw new TypeError("botId must be a positive safe integer");
    }

    this.deduplicator = dependencies.deduplicator;
    this.businessConnections = dependencies.businessConnections;
    this.chats = dependencies.chats;
    this.access = dependencies.access;
    this.settings = dependencies.settings;
    this.replyQueue = dependencies.replyQueue;
    this.ownerCommands = dependencies.ownerCommands;
    this.botId = dependencies.botId;
  }

  public async process(
    update: TelegramUpdate,
    signal?: AbortSignal,
  ): Promise<UpdateProcessingResult> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new TypeError("Telegram update_id must be a non-negative safe integer");
    }

    const updateType = detectUpdateType(update);
    const updateId = BigInt(update.update_id);
    const claimed = await this.deduplicator.claim(updateId, updateType);

    if (!claimed) {
      return { status: "duplicate", updateType };
    }

    try {
      await this.route(update, updateType, updateId, signal);
    } catch (caught) {
      const error = toError(caught);
      await this.deduplicator.fail(updateId, safeErrorCode(error));
      throw error;
    }

    // Completion is intentionally outside the handler catch. If the completion
    // write has an ambiguous outcome, leaving PROCESSING/COMPLETED is safer than
    // marking the update FAILED and immediately repeating external side effects.
    await this.deduplicator.complete(updateId);
    return { status: "processed", updateType };
  }

  private async route(
    update: TelegramUpdate,
    updateType: RoutedUpdateType,
    updateId: bigint,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    switch (updateType) {
      case "message":
        if (update.message !== undefined) {
          await this.ownerCommands.handle(update.message, signal);
        }
        return;

      case "business_connection":
        if (update.business_connection !== undefined) {
          await this.handleBusinessConnection(update.business_connection);
        }
        return;

      case "business_message":
        if (update.business_message !== undefined) {
          await this.handleBusinessMessage(
            update.business_message,
            false,
            updateId,
            signal,
          );
        }
        return;

      case "edited_business_message":
        if (update.edited_business_message !== undefined) {
          await this.handleBusinessMessage(
            update.edited_business_message,
            true,
            updateId,
            signal,
          );
        }
        return;

      case "deleted_business_messages": {
        const deleted = update.deleted_business_messages;
        if (deleted === undefined || deleted.message_ids.length === 0) {
          return;
        }

        const chat = await this.chats.markDeleted(
          deleted.business_connection_id,
          BigInt(deleted.chat.id),
          deleted.message_ids.map((messageId) => BigInt(messageId)),
        );
        if (chat !== null) {
          await this.replyQueue.cancel(chat.id);
        }
        return;
      }

      case "unsupported":
      case "invalid":
        return;
    }
  }

  private async handleBusinessConnection(
    connection: BusinessConnection,
  ): Promise<void> {
    await this.businessConnections.store(connection);

    if (!connection.is_enabled || connection.rights?.can_reply !== true) {
      await this.businessConnections.cancelJobsForDisabledConnection(
        connection.id,
      );
    }
  }

  private async handleBusinessMessage(
    message: TelegramMessage,
    edited: boolean,
    updateId: bigint,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const connectionId = message.business_connection_id;
    if (connectionId === undefined || connectionId.length === 0) {
      return;
    }

    const storedConnection = await this.businessConnections.getOrFetch(
      connectionId,
      signal,
    );
    const connection = toTelegramConnection(storedConnection);
    const source = classifyBusinessMessage(message, connection, this.botId);
    const chat = await this.chats.upsertChat(connection, message);

    await this.chats.storeMessage({
      chatId: chat.id,
      updateId,
      message,
      source,
      edited,
    });

    if (source === "owner") {
      await this.replyQueue.cancel(chat.id);
      return;
    }

    if (source !== "incoming_user") {
      return;
    }

    if (message.chat.type !== "private") {
      await this.replyQueue.cancel(chat.id);
      return;
    }

    const [settings, rules] = await Promise.all([
      this.settings.get(),
      this.access.getRules(connectionId, BigInt(message.chat.id)),
    ]);
    const decision = evaluateReplyPolicy({
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
        unsupportedAttachmentPolicy:
          settings.unsupportedAttachmentPolicy === "NEUTRAL"
            ? "NEUTRAL"
            : "SKIP",
      },
      connectionEnabled: storedConnection.isEnabled,
      connectionCanReply: storedConnection.canReply,
      manualMode: chat.manualMode,
      hasAllowRule: rules.allowed,
      hasDenyRule: rules.denied,
      kind: toPolicyMessageKind(detectMessageKind(message)),
      text: extractMessageText(message),
    });

    if (!decision.allowed) {
      await this.replyQueue.cancel(chat.id);
      return;
    }

    await this.replyQueue.schedule(
      chat.id,
      BigInt(message.message_id),
      settings.debounceMs,
    );
  }
}

function detectUpdateType(update: TelegramUpdate): RoutedUpdateType {
  const present: RoutedUpdateType[] = [];

  if (update.message !== undefined) {
    present.push("message");
  }
  if (update.business_connection !== undefined) {
    present.push("business_connection");
  }
  if (update.business_message !== undefined) {
    present.push("business_message");
  }
  if (update.edited_business_message !== undefined) {
    present.push("edited_business_message");
  }
  if (update.deleted_business_messages !== undefined) {
    present.push("deleted_business_messages");
  }

  if (present.length === 0) {
    return "unsupported";
  }
  if (present.length !== 1) {
    return "invalid";
  }
  return present[0] ?? "invalid";
}

function toTelegramConnection(
  stored: StoredBusinessConnection,
): BusinessConnection {
  const ownerId = safeTelegramNumber(stored.ownerTelegramId, "ownerTelegramId");
  const ownerChatId = safeTelegramNumber(stored.ownerChatId, "ownerChatId");

  return {
    id: stored.id,
    user: {
      id: ownerId,
      is_bot: false,
      first_name: stored.ownerFirstName ?? "Business owner",
      ...(stored.ownerLastName === null
        ? {}
        : { last_name: stored.ownerLastName }),
      ...(stored.ownerUsername === null
        ? {}
        : { username: stored.ownerUsername }),
    },
    user_chat_id: ownerChatId,
    date: Math.floor(stored.connectedAt.getTime() / 1_000),
    ...(stored.canReply ? { rights: { can_reply: true as const } } : {}),
    is_enabled: stored.isEnabled,
  };
}

function safeTelegramNumber(value: bigint, field: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new RangeError(`${field} is outside JavaScript's safe integer range`);
  }
  return numberValue;
}

function toPolicyMessageKind(value: string): PolicyMessageKind {
  switch (value) {
    case "TEXT":
    case "CAPTION":
    case "STICKER":
    case "REACTION":
    case "SERVICE":
      return value;
    default:
      return "UNSUPPORTED";
  }
}

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Unknown update processing failure");
}

function safeErrorCode(error: Error): string {
  const candidate = error as Error & { code?: unknown };
  if (
    typeof candidate.code === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/u.test(candidate.code)
  ) {
    return candidate.code;
  }

  const name = error.name.replace(/[^A-Za-z0-9_.-]/gu, "_");
  return (name || "Error").slice(0, 100);
}

export type { BusinessMessageSource };
