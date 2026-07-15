import type {
  BusinessConnection,
  TelegramMessage,
} from "./types.js";

export type BusinessMessageSource =
  | "incoming_user"
  | "owner"
  | "this_bot"
  | "other_business_bot"
  | "other_bot"
  | "unknown";

/**
 * Determines who authored a message visible through a business connection.
 * Telegram has no standalone `outgoing` flag in the HTTP Bot API.
 */
export function classifyBusinessMessage(
  message: TelegramMessage,
  connection: BusinessConnection,
  botId: number,
): BusinessMessageSource {
  if (message.sender_business_bot?.id === botId) {
    return "this_bot";
  }

  if (message.sender_business_bot !== undefined) {
    return "other_business_bot";
  }

  if (message.from === undefined) {
    return "unknown";
  }

  if (message.from.id === connection.user.id) {
    return "owner";
  }

  if (message.from.is_bot) {
    return "other_bot";
  }

  return "incoming_user";
}

export function isMessageForBusinessConnection(
  message: TelegramMessage,
  connection: BusinessConnection,
): boolean {
  return message.business_connection_id === connection.id;
}

export function canReplyThroughBusinessConnection(
  connection: BusinessConnection,
): boolean {
  return connection.is_enabled && connection.rights?.can_reply === true;
}

export function shouldAutoReplyToBusinessMessage(
  message: TelegramMessage,
  connection: BusinessConnection,
  botId: number,
): boolean {
  return (
    isMessageForBusinessConnection(message, connection) &&
    canReplyThroughBusinessConnection(connection) &&
    classifyBusinessMessage(message, connection, botId) === "incoming_user"
  );
}
