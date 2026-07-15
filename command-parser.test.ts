import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import express from "express";
import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "pino";

import type { HealthService } from "../health/health-service.js";
import { isHealthy } from "../health/health-service.js";
import type { TelegramUpdate } from "../telegram/types.js";

const WEBHOOK_PATH = "/telegram/webhook";
const JSON_BODY_LIMIT = "256kb";
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 300;

const KNOWN_UPDATE_FIELDS = [
  "message",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
] as const;

export interface UpdateProcessorLike {
  process(update: TelegramUpdate): Promise<unknown>;
}

export interface CreateAppOptions {
  readonly healthService: HealthService;
  readonly updateProcessor: UpdateProcessorLike;
  readonly webhookSecret: string;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly rateLimitWindowMs?: number;
  readonly rateLimitMaxRequests?: number;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(assignRequestId);

  app.get("/health", async (_request, response): Promise<void> => {
    response.setHeader("cache-control", "no-store");
    const report = await options.healthService.check();

    if (!isHealthy(report)) {
      options.logger.warn(
        {
          dependencies: Object.entries(report.dependencies)
            .filter(([, health]) => health.status === "down")
            .map(([dependency]) => dependency),
        },
        "Health check is degraded",
      );
    }

    response.status(isHealthy(report) ? 200 : 503).json(report);
  });

  const webhookRateLimiter = rateLimit({
    windowMs:
      options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    limit:
      options.rateLimitMaxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    handler(request, response) {
      const requestId = getRequestId(response);
      options.logger.warn(
        { requestId, remoteAddress: request.ip },
        "Telegram webhook rate limit exceeded",
      );
      response.status(429).json({
        ok: false,
        error: "rate_limited",
        requestId,
      });
    },
  });

  app.post(
    WEBHOOK_PATH,
    webhookRateLimiter,
    verifyWebhookSecret(options.webhookSecret, options.logger),
    requireJsonContentType,
    express.json({ limit: JSON_BODY_LIMIT, strict: true }),
    async (request, response): Promise<void> => {
      const requestId = getRequestId(response);
      const update = parseTelegramUpdate(request.body as unknown);

      if (update === undefined) {
        options.logger.warn(
          { requestId },
          "Rejected malformed Telegram update",
        );
        response.status(400).json({
          ok: false,
          error: "invalid_update",
          requestId,
        });
        return;
      }

      options.logger.info(
        {
          requestId,
          updateId: update.update_id,
          updateType: getUpdateType(update),
        },
        "Telegram update received",
      );

      await options.updateProcessor.process(update);
      response.status(200).json({ ok: true });
    },
  );

  app.use((request, response) => {
    response.status(404).json({
      ok: false,
      error: "not_found",
      requestId: getRequestId(response),
    });
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = getRequestId(response);
    const clientError = classifyClientError(error);
    if (clientError !== undefined) {
      options.logger.warn(
        { requestId, method: request.method, path: request.path },
        "Rejected invalid HTTP request",
      );
      response.status(clientError.status).json({
        ok: false,
        error: clientError.code,
        requestId,
      });
      return;
    }

    options.logger.error(
      {
        err: error,
        requestId,
        method: request.method,
        path: request.path,
      },
      "HTTP request failed",
    );
    response.status(500).json({
      ok: false,
      error: "internal_error",
      requestId,
    });
  };

  app.use(errorHandler);
  return app;
}

const assignRequestId: RequestHandler = (_request, response, next): void => {
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
};

const requireJsonContentType: RequestHandler = (request, response, next): void => {
  if (!request.is("application/json")) {
    response.status(415).json({
      ok: false,
      error: "unsupported_media_type",
      requestId: getRequestId(response),
    });
    return;
  }

  next();
};

function verifyWebhookSecret(
  expectedSecret: string,
  logger: Pick<Logger, "warn">,
): RequestHandler {
  const expectedDigest = digestSecret(expectedSecret);

  return (request, response, next): void => {
    const providedSecret = request.get(
      "x-telegram-bot-api-secret-token",
    );

    if (
      providedSecret === undefined ||
      !timingSafeEqual(digestSecret(providedSecret), expectedDigest)
    ) {
      const requestId = getRequestId(response);
      logger.warn(
        { requestId, remoteAddress: request.ip },
        "Rejected Telegram webhook with invalid secret",
      );
      response.status(401).json({
        ok: false,
        error: "unauthorized",
        requestId,
      });
      return;
    }

    next();
  };
}

function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function parseTelegramUpdate(value: unknown): TelegramUpdate | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("update_id" in value)
  ) {
    return undefined;
  }

  const updateId = value.update_id;
  if (
    typeof updateId !== "number" ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0
  ) {
    return undefined;
  }

  return value as TelegramUpdate;
}

function getUpdateType(update: TelegramUpdate): string {
  return (
    KNOWN_UPDATE_FIELDS.find((field) => update[field] !== undefined) ??
    "unsupported"
  );
}

function getRequestId(response: Response): string {
  const requestId = response.locals.requestId as unknown;
  return typeof requestId === "string" ? requestId : "unknown";
}

function classifyClientError(
  error: unknown,
): { readonly status: number; readonly code: string } | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; type?: unknown };
  if (candidate.status === 413 || candidate.type === "entity.too.large") {
    return { status: 413, code: "payload_too_large" };
  }

  if (candidate.status === 400 && candidate.type === "entity.parse.failed") {
    return { status: 400, code: "invalid_json" };
  }

  if (
    candidate.status === 415 &&
    (candidate.type === "charset.unsupported" ||
      candidate.type === "encoding.unsupported")
  ) {
    return { status: 415, code: "unsupported_media_type" };
  }

  return undefined;
}
