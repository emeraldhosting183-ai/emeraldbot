import { isWithinSchedule } from "./schedule.js";

export type PolicyMessageKind =
  | "TEXT"
  | "CAPTION"
  | "STICKER"
  | "REACTION"
  | "SERVICE"
  | "UNSUPPORTED";

export interface ReplyPolicySettings {
  autoReplyEnabled: boolean;
  allowlistOnly: boolean;
  scheduleEnabled: boolean;
  scheduleStartMinute: number;
  scheduleEndMinute: number;
  scheduleDays: string;
  timezone: string;
  ignoreOneWord: boolean;
  ignoreReactions: boolean;
  ignoreStickers: boolean;
  ignoreServiceMessages: boolean;
  unsupportedAttachmentPolicy: "SKIP" | "NEUTRAL";
}

export interface ReplyPolicyInput {
  settings: ReplyPolicySettings;
  connectionEnabled: boolean;
  connectionCanReply: boolean;
  manualMode: boolean;
  hasAllowRule: boolean;
  hasDenyRule: boolean;
  kind: PolicyMessageKind;
  text: string | null;
  now?: Date;
}

export type ReplyPolicyReason =
  | "allowed"
  | "auto_reply_paused"
  | "connection_disabled"
  | "missing_reply_permission"
  | "manual_mode"
  | "denylisted"
  | "not_allowlisted"
  | "outside_schedule"
  | "one_word_ignored"
  | "reaction_ignored"
  | "sticker_ignored"
  | "service_ignored"
  | "unsupported_attachment_ignored";

export interface ReplyPolicyDecision {
  allowed: boolean;
  reason: ReplyPolicyReason;
}

export function evaluateReplyPolicy(
  input: ReplyPolicyInput,
): ReplyPolicyDecision {
  if (!input.settings.autoReplyEnabled) {
    return deny("auto_reply_paused");
  }
  if (!input.connectionEnabled) {
    return deny("connection_disabled");
  }
  if (!input.connectionCanReply) {
    return deny("missing_reply_permission");
  }
  if (input.manualMode) {
    return deny("manual_mode");
  }
  if (input.hasDenyRule) {
    return deny("denylisted");
  }
  if (input.settings.allowlistOnly && !input.hasAllowRule) {
    return deny("not_allowlisted");
  }
  if (
    !isWithinSchedule(
      {
        enabled: input.settings.scheduleEnabled,
        timezone: input.settings.timezone,
        startMinute: input.settings.scheduleStartMinute,
        endMinute: input.settings.scheduleEndMinute,
        days: input.settings.scheduleDays,
      },
      input.now,
    )
  ) {
    return deny("outside_schedule");
  }
  if (input.kind === "REACTION" && input.settings.ignoreReactions) {
    return deny("reaction_ignored");
  }
  if (input.kind === "STICKER" && input.settings.ignoreStickers) {
    return deny("sticker_ignored");
  }
  if (input.kind === "SERVICE" && input.settings.ignoreServiceMessages) {
    return deny("service_ignored");
  }
  if (
    input.kind === "UNSUPPORTED" &&
    input.settings.unsupportedAttachmentPolicy === "SKIP"
  ) {
    return deny("unsupported_attachment_ignored");
  }
  if (
    input.settings.ignoreOneWord &&
    input.text !== null &&
    input.text.split(/\s+/u).filter(Boolean).length === 1
  ) {
    return deny("one_word_ignored");
  }
  return { allowed: true, reason: "allowed" };
}

function deny(reason: Exclude<ReplyPolicyReason, "allowed">): ReplyPolicyDecision {
  return { allowed: false, reason };
}
