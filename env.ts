/** Types used by the subset of the Telegram Bot API handled by this app. */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: true;
  can_connect_to_business?: boolean;
  [key: string]: unknown;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: true;
  [key: string]: unknown;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
  custom_emoji_id?: string;
  [key: string]: unknown;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
  [key: string]: unknown;
}

export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  type: "regular" | "mask" | "custom_emoji";
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
  set_name?: string;
  custom_emoji_id?: string;
  file_size?: number;
  [key: string]: unknown;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  sender_business_bot?: TelegramUser;
  date: number;
  business_connection_id?: string;
  chat: TelegramChat;
  edit_date?: number;
  is_from_offline?: true;
  media_group_id?: string;
  text?: string;
  entities?: TelegramMessageEntity[];
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  sticker?: TelegramSticker;
  animation?: unknown;
  audio?: unknown;
  document?: unknown;
  video?: unknown;
  video_note?: unknown;
  voice?: unknown;
  contact?: unknown;
  dice?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  reply_to_message?: TelegramMessage;
  [key: string]: unknown;
}

/** Optional `True` fields are omitted by Telegram when the right is absent. */
export interface BusinessBotRights {
  can_reply?: true;
  can_read_messages?: true;
  can_delete_sent_messages?: true;
  can_delete_all_messages?: true;
  can_edit_name?: true;
  can_edit_bio?: true;
  can_edit_profile_photo?: true;
  can_edit_username?: true;
  can_change_gift_settings?: true;
  can_view_gifts_and_stars?: true;
  can_convert_gifts_to_stars?: true;
  can_transfer_and_upgrade_gifts?: true;
  can_transfer_stars?: true;
  can_manage_stories?: true;
  [key: string]: unknown;
}

export interface BusinessConnection {
  id: string;
  user: TelegramUser;
  user_chat_id: number;
  date: number;
  rights?: BusinessBotRights;
  is_enabled: boolean;
  [key: string]: unknown;
}

export interface BusinessMessagesDeleted {
  business_connection_id: string;
  chat: TelegramChat;
  message_ids: number[];
  [key: string]: unknown;
}

/**
 * Telegram guarantees that at most one update payload is present. Optional
 * properties keep decoding forward-compatible with update types not used here.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  business_connection?: BusinessConnection;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: BusinessMessagesDeleted;
  [key: string]: unknown;
}

export type OwnerCommandUpdate = TelegramUpdate & {
  message: TelegramMessage;
};

export type BusinessConnectionUpdate = TelegramUpdate & {
  business_connection: BusinessConnection;
};

export type BusinessMessageUpdate = TelegramUpdate & {
  business_message: TelegramMessage;
};

export type EditedBusinessMessageUpdate = TelegramUpdate & {
  edited_business_message: TelegramMessage;
};

export type DeletedBusinessMessagesUpdate = TelegramUpdate & {
  deleted_business_messages: BusinessMessagesDeleted;
};

export type SupportedTelegramUpdate =
  | OwnerCommandUpdate
  | BusinessConnectionUpdate
  | BusinessMessageUpdate
  | EditedBusinessMessageUpdate
  | DeletedBusinessMessagesUpdate;

export type TelegramChatId = number | string;

export type TelegramParseMode = "HTML" | "Markdown" | "MarkdownV2";

export interface TelegramReplyParameters {
  message_id: number;
  chat_id?: TelegramChatId;
  allow_sending_without_reply?: boolean;
  quote?: string;
  quote_parse_mode?: TelegramParseMode;
  quote_entities?: TelegramMessageEntity[];
  quote_position?: number;
  [key: string]: unknown;
}

export interface SendMessageParams {
  business_connection_id?: string;
  chat_id: TelegramChatId;
  message_thread_id?: number;
  text: string;
  parse_mode?: TelegramParseMode;
  entities?: TelegramMessageEntity[];
  link_preview_options?: Record<string, unknown>;
  disable_notification?: boolean;
  protect_content?: boolean;
  allow_paid_broadcast?: boolean;
  message_effect_id?: string;
  reply_parameters?: TelegramReplyParameters;
  reply_markup?: Record<string, unknown>;
}

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export interface SendChatActionParams {
  business_connection_id?: string;
  chat_id: TelegramChatId;
  message_thread_id?: number;
  action: TelegramChatAction;
}

export type TelegramUpdateType =
  | "message"
  | "edited_message"
  | "channel_post"
  | "edited_channel_post"
  | "business_connection"
  | "business_message"
  | "edited_business_message"
  | "deleted_business_messages"
  | "guest_message"
  | "message_reaction"
  | "message_reaction_count"
  | "inline_query"
  | "chosen_inline_result"
  | "callback_query"
  | "shipping_query"
  | "pre_checkout_query"
  | "purchased_paid_media"
  | "poll"
  | "poll_answer"
  | "my_chat_member"
  | "chat_member"
  | "chat_join_request"
  | "chat_boost"
  | "removed_chat_boost"
  | "managed_bot"
  | "subscription";

export interface SetWebhookParams {
  url: string;
  ip_address?: string;
  max_connections?: number;
  allowed_updates?: readonly TelegramUpdateType[];
  drop_pending_updates?: boolean;
  secret_token?: string;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
  [key: string]: unknown;
}

export interface TelegramResponseParameters {
  migrate_to_chat_id?: number;
  retry_after?: number;
  [key: string]: unknown;
}

export interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
}

export interface TelegramApiFailure {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: TelegramResponseParameters;
}

export type TelegramApiResponse<T> =
  | TelegramApiSuccess<T>
  | TelegramApiFailure;

// Familiar Bot API aliases for callers that prefer the official object names.
export type User = TelegramUser;
export type Chat = TelegramChat;
export type Message = TelegramMessage;
export type Update = TelegramUpdate;
export type WebhookInfo = TelegramWebhookInfo;
