import type {
  BusinessConnection,
  SendChatActionParams,
  SendMessageParams,
  SetWebhookParams,
  TelegramApiFailure,
  TelegramMessage,
  TelegramResponseParameters,
  TelegramUser,
  TelegramWebhookInfo,
} from "./types.js";

const DEFAULT_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type FetchFunction = typeof globalThis.fetch;

export interface TelegramRequestOptions {
  signal?: AbortSignal;
}

export type TelegramRequestControl = AbortSignal | TelegramRequestOptions;

export interface TelegramClientRuntimeOptions {
  apiBaseUrl?: string;
  fetch?: FetchFunction;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface TelegramClientOptions extends TelegramClientRuntimeOptions {
  token: string;
}

export interface GetBusinessConnectionParams {
  business_connection_id: string;
}

interface TelegramApiErrorOptions {
  method: string;
  description: string;
  errorCode?: number;
  httpStatus?: number;
  parameters?: TelegramResponseParameters;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number | undefined;
  readonly httpStatus: number | undefined;
  readonly parameters: TelegramResponseParameters | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(options: TelegramApiErrorOptions) {
    const code = options.errorCode ?? options.httpStatus;
    const codeLabel = code === undefined ? "" : ` (${String(code)})`;
    super(`Telegram API ${options.method} failed${codeLabel}: ${options.description}`);

    this.name = "TelegramApiError";
    this.method = options.method;
    this.errorCode = options.errorCode;
    this.httpStatus = options.httpStatus;
    this.parameters = options.parameters;
    this.retryAfterSeconds = options.parameters?.retry_after;
    this.retryAfter = this.retryAfterSeconds;
  }
}

export class TelegramClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchFunction;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: TelegramClientOptions);
  constructor(token: string, options?: TelegramClientRuntimeOptions);
  constructor(
    tokenOrOptions: string | TelegramClientOptions,
    runtimeOptions: TelegramClientRuntimeOptions = {},
  ) {
    const options: TelegramClientOptions =
      typeof tokenOrOptions === "string"
        ? { ...runtimeOptions, token: tokenOrOptions }
        : tokenOrOptions;

    if (options.token.trim().length === 0) {
      throw new TypeError("Telegram bot token must not be empty");
    }

    assertNonNegativeInteger(options.maxRetries, "maxRetries");
    assertNonNegativeNumber(
      options.initialRetryDelayMs,
      "initialRetryDelayMs",
    );
    assertNonNegativeNumber(options.maxRetryDelayMs, "maxRetryDelayMs");

    this.token = options.token;
    this.apiBaseUrl = (
      options.apiBaseUrl ?? DEFAULT_API_BASE_URL
    ).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialRetryDelayMs =
      options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    this.maxRetryDelayMs =
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  getMe(control?: TelegramRequestControl): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe", {}, resolveSignal(control));
  }

  getBusinessConnection(
    connection: string | GetBusinessConnectionParams,
    control?: TelegramRequestControl,
  ): Promise<BusinessConnection> {
    const businessConnectionId =
      typeof connection === "string"
        ? connection
        : connection.business_connection_id;

    return this.request<BusinessConnection>(
      "getBusinessConnection",
      { business_connection_id: businessConnectionId },
      resolveSignal(control),
    );
  }

  sendMessage(
    params: SendMessageParams,
    control?: TelegramRequestControl,
  ): Promise<TelegramMessage> {
    return this.request<TelegramMessage>(
      "sendMessage",
      params,
      resolveSignal(control),
    );
  }

  sendChatAction(
    params: SendChatActionParams,
    control?: TelegramRequestControl,
  ): Promise<boolean> {
    return this.request<boolean>(
      "sendChatAction",
      params,
      resolveSignal(control),
    );
  }

  setWebhook(
    params: SetWebhookParams,
    control?: TelegramRequestControl,
  ): Promise<boolean> {
    return this.request<boolean>(
      "setWebhook",
      params,
      resolveSignal(control),
    );
  }

  getWebhookInfo(
    control?: TelegramRequestControl,
  ): Promise<TelegramWebhookInfo> {
    return this.request<TelegramWebhookInfo>(
      "getWebhookInfo",
      {},
      resolveSignal(control),
    );
  }

  private async request<T>(
    method: string,
    payload: object,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);

      let response: Response;
      try {
        const requestInit: RequestInit = {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        };
        if (signal !== undefined) {
          requestInit.signal = signal;
        }

        response = await this.fetchFn(url, requestInit);
      } catch {
        throwIfAborted(signal);

        if (attempt >= this.maxRetries) {
          throw new TelegramApiError({
            method,
            description: "network request failed after retries",
          });
        }

        await abortableDelay(this.exponentialDelay(attempt), signal);
        continue;
      }

      const decoded = await decodeResponse(response);
      throwIfAborted(signal);
      if (isTelegramSuccess(decoded)) {
        return decoded.result as T;
      }

      const failure = isTelegramFailure(decoded) ? decoded : undefined;
      const parameters = toResponseParameters(failure?.parameters);
      const errorCode = failure?.error_code ?? response.status;
      const apiError = new TelegramApiError({
        method,
        description:
          failure?.description ?? "Telegram returned an invalid API response",
        errorCode,
        httpStatus: response.status,
        ...(parameters === undefined ? {} : { parameters }),
      });

      if (
        attempt >= this.maxRetries ||
        !isRetryableResponse(response.status, errorCode)
      ) {
        throw apiError;
      }

      const retryAfterMs = getRetryAfterMs(response, parameters);
      await abortableDelay(
        retryAfterMs ?? this.exponentialDelay(attempt),
        signal,
      );
    }
  }

  private exponentialDelay(attempt: number): number {
    const multiplier = 2 ** Math.min(attempt, 30);
    return Math.min(
      this.maxRetryDelayMs,
      this.initialRetryDelayMs * multiplier,
    );
  }
}

function assertNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 0)
  ) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function assertNonNegativeNumber(
  value: number | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < 0)
  ) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function resolveSignal(
  control: TelegramRequestControl | undefined,
): AbortSignal | undefined {
  if (control === undefined) {
    return undefined;
  }

  if (isAbortSignal(control)) {
    return control;
  }

  return control.signal;
}

function isAbortSignal(value: TelegramRequestControl): value is AbortSignal {
  return (
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error("Telegram API request was aborted");
  error.name = "AbortError";
  throw error;
}

async function abortableDelay(
  requestedDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);

  const delayMs = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(0, Math.ceil(requestedDelayMs)),
  );

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      cleanup();
      if (signal?.reason instanceof Error) {
        reject(signal.reason);
        return;
      }

      const error = new Error("Telegram API request was aborted");
      error.name = "AbortError";
      reject(error);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function decodeResponse(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTelegramSuccess(
  value: unknown,
): value is { ok: true; result: unknown } {
  return isRecord(value) && value.ok === true && "result" in value;
}

function isTelegramFailure(value: unknown): value is TelegramApiFailure {
  return isRecord(value) && value.ok === false;
}

function toResponseParameters(
  value: unknown,
): TelegramResponseParameters | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const parameters: TelegramResponseParameters = {};
  for (const [key, entry] of Object.entries(value)) {
    parameters[key] = entry;
  }

  if (
    typeof value.retry_after !== "number" ||
    !Number.isFinite(value.retry_after) ||
    value.retry_after < 0
  ) {
    delete parameters.retry_after;
  }

  if (
    typeof value.migrate_to_chat_id !== "number" ||
    !Number.isSafeInteger(value.migrate_to_chat_id)
  ) {
    delete parameters.migrate_to_chat_id;
  }

  return parameters;
}

function isRetryableResponse(httpStatus: number, errorCode: number): boolean {
  return (
    httpStatus === 408 ||
    httpStatus === 425 ||
    httpStatus === 429 ||
    httpStatus >= 500 ||
    errorCode === 429 ||
    errorCode >= 500
  );
}

function getRetryAfterMs(
  response: Response,
  parameters: TelegramResponseParameters | undefined,
): number | undefined {
  const delays: number[] = [];

  if (parameters?.retry_after !== undefined) {
    delays.push(parameters.retry_after * 1_000);
  }

  const headerDelay = parseRetryAfterHeader(
    response.headers.get("retry-after"),
  );
  if (headerDelay !== undefined) {
    delays.push(headerDelay);
  }

  return delays.length === 0 ? undefined : Math.max(...delays);
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryDate = Date.parse(value);
  if (Number.isNaN(retryDate)) {
    return undefined;
  }

  return Math.max(0, retryDate - Date.now());
}
