import {
  MessageDirection,
  MessageKind,
} from "../generated/prisma/enums.js";
import type { BusinessMessageSource } from "../telegram/classify.js";
import type { TelegramMessage } from "../telegram/types.js";

const SERVICE_FIELDS = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "proximity_alert_triggered",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "web_app_data",
] as const;

export function extractMessageText(message: TelegramMessage): string | null {
  const value = message.text ?? message.caption;
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function detectMessageKind(message: TelegramMessage): MessageKind {
  if (message.text?.trim()) {
    return MessageKind.TEXT;
  }
  if (message.caption?.trim()) {
    return MessageKind.CAPTION;
  }
  if (message.sticker !== undefined) {
    return MessageKind.STICKER;
  }
  if (SERVICE_FIELDS.some((field) => Object.hasOwn(message, field))) {
    return MessageKind.SERVICE;
  }
  return MessageKind.UNSUPPORTED;
}

export function sourceToDirection(
  source: BusinessMessageSource,
): MessageDirection {
  switch (source) {
    case "incoming_user":
      return MessageDirection.INBOUND;
    case "owner":
      return MessageDirection.OWNER_OUTBOUND;
    case "this_bot":
      return MessageDirection.BOT_OUTBOUND;
    case "other_bot":
    case "other_business_bot":
    case "unknown":
      return MessageDirection.IGNORED;
  }
}
