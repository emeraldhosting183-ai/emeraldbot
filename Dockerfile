import { DateTime } from "luxon";

import { formatClock, parseClock } from "../domain/schedule.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { AccessService } from "../services/access-service.js";
import type { ChatService } from "../services/chat-service.js";
import type { SettingsService } from "../services/settings-service.js";
import type { TelegramClient } from "../telegram/telegram-client.js";
import type { TelegramMessage } from "../telegram/types.js";
import { splitTelegramText, truncateText } from "../utils/text.js";
import { parseOwnerCommand, parseToggle } from "./command-parser.js";

interface QueueControl {
  cancel(chatId: string): Promise<boolean>;
}

type ResolvedChat = Awaited<ReturnType<ChatService["findByTelegramId"]>>[number];

export class OwnerCommandService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly telegram: TelegramClient,
    private readonly settingsService: SettingsService,
    private readonly chatService: ChatService,
    private readonly accessService: AccessService,
    private readonly queue: QueueControl,
    private readonly ownerId: bigint,
  ) {}

  public async handle(message: TelegramMessage, signal?: AbortSignal): Promise<boolean> {
    const command = parseOwnerCommand(message.text);
    if (!command) {
      return false;
    }
    if (message.from?.id === undefined || BigInt(message.from.id) !== this.ownerId) {
      return true;
    }

    try {
      const response = await this.execute(command.name, command.arguments);
      await this.reply(message.chat.id, response, signal);
    } catch (error) {
      const response = error instanceof CommandInputError
        ? error.message
        : "Не удалось выполнить команду. Подробности записаны в безопасный журнал.";
      await this.reply(message.chat.id, response, signal);
      if (!(error instanceof CommandInputError)) {
        throw error;
      }
    }
    return true;
  }

  private async execute(name: string, argumentsText: string): Promise<string> {
    switch (name) {
      case "start":
        return HELP_TEXT;
      case "status":
        return this.status();
      case "pause":
        return this.setPause(argumentsText, true);
      case "resume":
        return this.setPause(argumentsText, false);
      case "settings":
        return this.settings(argumentsText);
      case "style":
        return this.style(argumentsText);
      case "history":
        return this.history(argumentsText);
      case "clear":
        return this.clear(argumentsText);
      case "allow":
        return this.rule(argumentsText, "ALLOW");
      case "deny":
        return this.rule(argumentsText, "DENY");
      default:
        throw new CommandInputError(`Неизвестная команда /${name}.\n\n${HELP_TEXT}`);
    }
  }

  private async status(): Promise<string> {
    const [settings, connections, chats, pending, usage] = await Promise.all([
      this.settingsService.get(),
      this.database.businessConnection.findMany({
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      this.database.chat.count(),
      this.database.replyJob.count({ where: { status: "PENDING" } }),
      this.database.usageRecord.aggregate({
        _sum: { totalTokens: true, estimatedCostUsd: true },
      }),
    ]);
    const connectionLines = connections.length === 0
      ? ["— подключений пока нет"]
      : connections.map(
          (connection) =>
            `— ${connection.ownerFirstName ?? connection.ownerTelegramId.toString()}: ${connection.isEnabled && connection.canReply ? "активно" : "нет права ответа"} (${connection.id})`,
        );
    return [
      `Автоответы: ${settings.autoReplyEnabled ? "включены" : "приостановлены"}`,
      `Режим: ${settings.allowlistOnly ? "только allowlist" : "все доступные чаты"}`,
      `AI: данные провайдера видны в /health`,
      `Чатов: ${chats}; ожидающих ответов: ${pending}`,
      `Токенов учтено: ${usage._sum.totalTokens ?? 0}`,
      `Примерная стоимость: $${usage._sum.estimatedCostUsd?.toString() ?? "0"}`,
      "Подключения:",
      ...connectionLines,
    ].join("\n");
  }

  private async setPause(argumentsText: string, paused: boolean): Promise<string> {
    if (!argumentsText) {
      await this.settingsService.update({ autoReplyEnabled: !paused });
      return paused ? "Автоответы глобально приостановлены." : "Автоответы глобально включены.";
    }
    const chat = await this.resolveChat(argumentsText);
    await this.chatService.setManualMode(chat.id, paused);
    if (paused) {
      await this.queue.cancel(chat.id);
    }
    return paused
      ? `Чат ${chat.telegramChatId.toString()} переведён в ручной режим.`
      : `Для чата ${chat.telegramChatId.toString()} снова включён автоматический режим.`;
  }

  private async settings(argumentsText: string): Promise<string> {
    if (!argumentsText) {
      return this.formatSettings(await this.settingsService.get());
    }
    const [key = "", ...rest] = argumentsText.split(/\s+/u);
    const value = rest.join(" ").trim();
    switch (key.toLowerCase()) {
      case "mode": {
        if (!['all', 'allowlist'].includes(value)) {
          throw new CommandInputError("Формат: /settings mode all|allowlist");
        }
        await this.settingsService.update({ allowlistOnly: value === "allowlist" });
        break;
      }
      case "delay": {
        const numbers = rest.map(Number);
        if (numbers.length !== 2 || numbers.some((item) => !Number.isInteger(item) || item < 0 || item > 30_000) || numbers[0]! > numbers[1]!) {
          throw new CommandInputError("Формат: /settings delay <min_ms> <max_ms>, диапазон 0–30000");
        }
        await this.settingsService.update({ minDelayMs: numbers[0]!, maxDelayMs: numbers[1]! });
        break;
      }
      case "max-length":
        await this.updateInteger("maxReplyChars", value, 50, 4096);
        break;
      case "history":
        await this.updateInteger("historyLimit", value, 1, 30);
        break;
      case "debounce":
        await this.updateInteger("debounceMs", value, 100, 10_000);
        break;
      case "cooldown":
        await this.updateInteger("cooldownSeconds", value, 0, 3_600);
        break;
      case "timezone": {
        if (!DateTime.local().setZone(value).isValid) {
          throw new CommandInputError("Укажите корректную IANA-зону, например Europe/Kyiv");
        }
        await this.settingsService.update({ timezone: value });
        break;
      }
      case "schedule":
        await this.updateSchedule(value);
        break;
      case "ignore-one-word":
        await this.updateToggle("ignoreOneWord", value);
        break;
      case "ignore-stickers":
        await this.updateToggle("ignoreStickers", value);
        break;
      case "ignore-reactions":
        await this.updateToggle("ignoreReactions", value);
        break;
      case "ignore-service":
        await this.updateToggle("ignoreServiceMessages", value);
        break;
      case "unsupported": {
        const policy = value.toLowerCase();
        if (policy !== "skip" && policy !== "neutral") {
          throw new CommandInputError("Формат: /settings unsupported skip|neutral");
        }
        await this.settingsService.update({ unsupportedAttachmentPolicy: policy === "skip" ? "SKIP" : "NEUTRAL" });
        break;
      }
      case "unsupported-text": {
        if (!value) {
          throw new CommandInputError("Добавьте нейтральный текст после /settings unsupported-text");
        }
        await this.settingsService.update({ unsupportedAttachmentReply: truncateText(value, 500) });
        break;
      }
      default:
        throw new CommandInputError(SETTINGS_HELP);
    }
    return this.formatSettings(await this.settingsService.get());
  }

  private async style(argumentsText: string): Promise<string> {
    if (!argumentsText) {
      const settings = await this.settingsService.get();
      return `Глобальный стиль:\n${settings.globalStyle}\n\nФормат чата: /style chat <chat_id> [connection_id] | <стиль|reset>`;
    }
    if (argumentsText === "reset") {
      await this.settingsService.update({ globalStyle: "Отвечай дружелюбно, спокойно и естественно." });
      return "Глобальный стиль сброшен.";
    }
    if (argumentsText.startsWith("chat ")) {
      const parts = /^chat\s+(?<selector>[^|]+?)\s*\|\s*(?<style>[\s\S]+)$/u.exec(argumentsText)?.groups;
      if (!parts?.selector || !parts.style) {
        throw new CommandInputError("Формат: /style chat <chat_id> [connection_id] | <стиль|reset>");
      }
      const chat = await this.resolveChat(parts.selector);
      const style = parts.style.trim() === "reset" ? null : truncateText(parts.style, 2_000);
      await this.chatService.setStyle(chat.id, style);
      return style ? "Индивидуальный стиль сохранён." : "Индивидуальный стиль сброшен.";
    }
    const style = argumentsText.replace(/^global\s+/u, "").trim();
    if (!style) {
      throw new CommandInputError("Добавьте описание стиля.");
    }
    await this.settingsService.update({ globalStyle: truncateText(style, 2_000) });
    return "Глобальный стиль сохранён.";
  }

  private async history(argumentsText: string): Promise<string> {
    if (!argumentsText) {
      throw new CommandInputError("Формат: /history <chat_id> [connection_id] [limit]");
    }
    const tokens = argumentsText.split(/\s+/u);
    let limit = 30;
    if (tokens.length > 1 && /^\d+$/u.test(tokens.at(-1)!)) {
      const candidate = Number(tokens.at(-1));
      if (candidate >= 1 && candidate <= 50) {
        limit = candidate;
        tokens.pop();
      }
    }
    const chat = await this.resolveChat(tokens.join(" "));
    const history = await this.chatService.getHistory(chat.id, limit);
    if (history.length === 0) {
      return "История этого чата пуста.";
    }
    return history
      .map((item) => `${item.role === "user" ? "Собеседник" : "Профиль"}: ${item.text}`)
      .join("\n\n");
  }

  private async clear(argumentsText: string): Promise<string> {
    const chat = await this.resolveChat(argumentsText);
    await this.queue.cancel(chat.id);
    await this.chatService.clearHistory(chat.id);
    return `История чата ${chat.telegramChatId.toString()} удалена.`;
  }

  private async rule(argumentsText: string, kind: "ALLOW" | "DENY"): Promise<string> {
    const chat = await this.resolveChat(argumentsText);
    await this.accessService.setRule(chat.businessConnectionId, chat.telegramChatId, kind);
    if (kind === "DENY") {
      await this.queue.cancel(chat.id);
    }
    return kind === "ALLOW" ? "Чат добавлен в allowlist." : "Чат добавлен в denylist.";
  }

  private async resolveChat(selector: string): Promise<ResolvedChat> {
    const [chatIdText, connectionId, ...extra] = selector.trim().split(/\s+/u);
    if (!chatIdText || extra.length > 0 || !/^-?\d+$/u.test(chatIdText)) {
      throw new CommandInputError("Укажите <chat_id> и, если подключений несколько, [connection_id].");
    }
    const chats = await this.chatService.findByTelegramId(BigInt(chatIdText), connectionId);
    if (chats.length === 0) {
      throw new CommandInputError("Чат ещё не найден в базе. Сначала он должен прислать сообщение.");
    }
    if (chats.length > 1) {
      throw new CommandInputError("Этот chat_id есть в нескольких профилях. Добавьте connection_id вторым аргументом.");
    }
    return chats[0]!;
  }

  private async updateInteger(
    field: "maxReplyChars" | "historyLimit" | "debounceMs" | "cooldownSeconds",
    value: string,
    minimum: number,
    maximum: number,
  ): Promise<void> {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new CommandInputError(`Допустимо целое число от ${minimum} до ${maximum}.`);
    }
    await this.settingsService.update({ [field]: number });
  }

  private async updateToggle(
    field: "ignoreOneWord" | "ignoreStickers" | "ignoreReactions" | "ignoreServiceMessages",
    value: string,
  ): Promise<void> {
    const enabled = parseToggle(value);
    if (enabled === undefined) {
      throw new CommandInputError("Укажите on или off.");
    }
    await this.settingsService.update({ [field]: enabled });
  }

  private async updateSchedule(value: string): Promise<void> {
    if (value.toLowerCase() === "off") {
      await this.settingsService.update({ scheduleEnabled: false });
      return;
    }
    const match = /^(?<start>\d{1,2}:\d{2})-(?<end>\d{1,2}:\d{2})(?:\s+(?<days>[0-6](?:,[0-6])*))?$/u.exec(value)?.groups;
    const start = match?.start ? parseClock(match.start) : undefined;
    const end = match?.end ? parseClock(match.end) : undefined;
    if (start === undefined || end === undefined) {
      throw new CommandInputError("Формат: /settings schedule HH:MM-HH:MM [0,1,2,3,4,5,6] или off");
    }
    await this.settingsService.update({
      scheduleEnabled: true,
      scheduleStartMinute: start,
      scheduleEndMinute: end,
      scheduleDays: match?.days ?? "0,1,2,3,4,5,6",
    });
  }

  private formatSettings(settings: Awaited<ReturnType<SettingsService["get"]>>): string {
    return [
      `Автоответы: ${settings.autoReplyEnabled ? "on" : "off"}`,
      `Режим: ${settings.allowlistOnly ? "allowlist" : "all"}`,
      `Задержка: ${settings.minDelayMs}–${settings.maxDelayMs} мс; debounce: ${settings.debounceMs} мс`,
      `Лимит: ${settings.maxReplyChars} символов; история: ${settings.historyLimit}; cooldown: ${settings.cooldownSeconds} с`,
      `Расписание: ${settings.scheduleEnabled ? `${formatClock(settings.scheduleStartMinute)}-${formatClock(settings.scheduleEndMinute)} (${settings.scheduleDays})` : "off"}`,
      `Часовой пояс: ${settings.timezone}`,
      `Игнорировать: одно слово=${settings.ignoreOneWord}, стикеры=${settings.ignoreStickers}, реакции=${settings.ignoreReactions}, служебные=${settings.ignoreServiceMessages}`,
      `Вложения без текста: ${settings.unsupportedAttachmentPolicy.toLowerCase()}`,
      "",
      SETTINGS_HELP,
    ].join("\n");
  }

  private async reply(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
    for (const part of splitTelegramText(text)) {
      await this.telegram.sendMessage({ chat_id: chatId, text: part }, signal);
    }
  }
}

class CommandInputError extends Error {}

const SETTINGS_HELP = [
  "Настройки:",
  "/settings mode all|allowlist",
  "/settings delay <min_ms> <max_ms>",
  "/settings max-length <50..4096>",
  "/settings history <1..30>",
  "/settings debounce <100..10000>",
  "/settings cooldown <0..3600>",
  "/settings timezone Europe/Kyiv",
  "/settings schedule 09:00-22:00 [0,1,2,3,4,5,6] | off",
  "/settings ignore-one-word|ignore-stickers|ignore-reactions|ignore-service on|off",
  "/settings unsupported skip|neutral",
  "/settings unsupported-text <текст>",
].join("\n");

const HELP_TEXT = [
  "Telegram Chat Automation готов к настройке.",
  "",
  "/status — состояние",
  "/pause [chat_id] [connection_id] — пауза глобально или ручной режим чата",
  "/resume [chat_id] [connection_id] — возобновить",
  "/settings — настройки",
  "/style <текст|reset> — глобальный стиль",
  "/style chat <chat_id> [connection_id] | <стиль|reset>",
  "/history <chat_id> [connection_id] [limit]",
  "/clear <chat_id> [connection_id]",
  "/allow <chat_id> [connection_id]",
  "/deny <chat_id> [connection_id]",
].join("\n");
