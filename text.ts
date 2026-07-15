import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const WEBHOOK_PATH = "/telegram/webhook";

const ALLOWED_UPDATES = [
  "message",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
] as const;

type JsonRecord = Record<string, unknown>;

type TelegramSuccess<T> = {
  ok: true;
  result: T;
};

type TelegramFailure = {
  ok: false;
  error_code: number | undefined;
  description: string | undefined;
};

type TelegramResponse<T> = TelegramSuccess<T> | TelegramFailure;

type WebhookInfo = {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address: string | undefined;
  last_error_date: number | undefined;
  last_error_message: string | undefined;
  last_synchronization_error_date: number | undefined;
  max_connections: number | undefined;
  allowed_updates: string[] | undefined;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Required environment variable ${name} is missing`);
  }

  return value;
}

function parseWebhookSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must contain 16-256 characters from A-Z, a-z, 0-9, _ and -",
    );
  }

  return value;
}

function buildWebhookUrl(rawBaseUrl: string): URL {
  let baseUrl: URL;

  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid absolute URL");
  }

  if (baseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS");
  }

  if (baseUrl.username || baseUrl.password) {
    throw new Error("PUBLIC_BASE_URL must not contain credentials");
  }

  baseUrl.search = "";
  baseUrl.hash = "";
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}${WEBHOOK_PATH}`;

  return baseUrl;
}

function parseTelegramResponse<T>(value: unknown): TelegramResponse<T> {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Telegram API returned an invalid response envelope");
  }

  if (value.ok) {
    if (!("result" in value)) {
      throw new Error("Telegram API returned a success response without a result");
    }

    return { ok: true, result: value.result as T };
  }

  return {
    ok: false,
    error_code:
      typeof value.error_code === "number" ? value.error_code : undefined,
    description:
      typeof value.description === "string" ? value.description : undefined,
  };
}

function parseWebhookInfo(value: unknown): WebhookInfo {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.has_custom_certificate !== "boolean" ||
    typeof value.pending_update_count !== "number"
  ) {
    throw new Error("Telegram API returned invalid webhook information");
  }

  if (
    value.allowed_updates !== undefined &&
    (!Array.isArray(value.allowed_updates) ||
      !value.allowed_updates.every((item) => typeof item === "string"))
  ) {
    throw new Error("Telegram API returned an invalid allowed_updates value");
  }

  return {
    url: value.url,
    has_custom_certificate: value.has_custom_certificate,
    pending_update_count: value.pending_update_count,
    ip_address:
      typeof value.ip_address === "string" ? value.ip_address : undefined,
    last_error_date:
      typeof value.last_error_date === "number"
        ? value.last_error_date
        : undefined,
    last_error_message:
      typeof value.last_error_message === "string"
        ? value.last_error_message
        : undefined,
    last_synchronization_error_date:
      typeof value.last_synchronization_error_date === "number"
        ? value.last_synchronization_error_date
        : undefined,
    max_connections:
      typeof value.max_connections === "number"
        ? value.max_connections
        : undefined,
    allowed_updates: value.allowed_updates,
  };
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (message, secret) => (secret ? message.replaceAll(secret, "[REDACTED]") : message),
    value,
  );
}

function createTelegramApi(token: string, secrets: readonly string[]) {
  const endpointFor = (method: string): URL =>
    new URL(`https://api.telegram.org/bot${token}/${method}`);

  return async function callTelegram<T>(
    method: string,
    body: JsonRecord = {},
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(endpointFor(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Telegram API request ${method} failed at the network level`);
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `Telegram API request ${method} returned non-JSON status ${response.status}`,
      );
    }

    const envelope = parseTelegramResponse<T>(payload);

    if (!response.ok || !envelope.ok) {
      const code = envelope.ok ? response.status : envelope.error_code ?? response.status;
      const description = envelope.ok
        ? "unexpected HTTP status"
        : envelope.description ?? "unknown Telegram API error";

      throw new Error(
        `Telegram API request ${method} failed (${code}): ${redact(description, secrets)}`,
      );
    }

    return envelope.result;
  };
}

function hasExactAllowedUpdates(actual: readonly string[] | undefined): boolean {
  if (!actual || actual.length !== ALLOWED_UPDATES.length) {
    return false;
  }

  const actualSet = new Set(actual);
  return ALLOWED_UPDATES.every((update) => actualSet.has(update));
}

async function main(): Promise<void> {
  const token = requireEnvironmentVariable("TELEGRAM_BOT_TOKEN");
  const webhookSecret = parseWebhookSecret(
    requireEnvironmentVariable("TELEGRAM_WEBHOOK_SECRET"),
  );
  const webhookUrl = buildWebhookUrl(
    requireEnvironmentVariable("PUBLIC_BASE_URL"),
  );
  const secrets = [token, webhookSecret] as const;
  const telegram = createTelegramApi(token, secrets);

  const configured = await telegram<boolean>("setWebhook", {
    url: webhookUrl.toString(),
    secret_token: webhookSecret,
    allowed_updates: [...ALLOWED_UPDATES],
    drop_pending_updates: false,
  });

  if (configured !== true) {
    throw new Error("Telegram API did not confirm webhook configuration");
  }

  const webhookInfo = parseWebhookInfo(
    await telegram<unknown>("getWebhookInfo"),
  );

  if (webhookInfo.url !== webhookUrl.toString()) {
    throw new Error("Webhook verification returned a different URL");
  }

  if (!hasExactAllowedUpdates(webhookInfo.allowed_updates)) {
    throw new Error("Webhook verification returned unexpected allowed_updates");
  }

  console.log(`Webhook configured and verified at ${webhookUrl.toString()}`);
  console.log(`Allowed updates: ${ALLOWED_UPDATES.join(", ")}`);
  console.log(`Pending updates: ${webhookInfo.pending_update_count}`);

  if (webhookInfo.last_error_message) {
    console.warn(
      `Telegram reports a previous delivery error: ${redact(webhookInfo.last_error_message, secrets)}`,
    );
  }
}

void main().catch((error: unknown) => {
  const secrets = [
    process.env.TELEGRAM_BOT_TOKEN ?? "",
    process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  ];
  const message = error instanceof Error ? error.message : "unknown error";

  console.error(`Webhook setup failed: ${redact(message, secrets)}`);
  process.exitCode = 1;
});
