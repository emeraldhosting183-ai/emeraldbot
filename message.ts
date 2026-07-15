import { sleep, throwIfAborted } from "./async.js";

export interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  shouldRetry: (error: unknown) => boolean;
  retryAfterMs?: (error: unknown) => number | undefined;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);

    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (attempt >= options.attempts || !options.shouldRetry(error)) {
        throw error;
      }

      const exponentialDelay = Math.min(
        options.maxDelayMs,
        options.initialDelayMs * 2 ** (attempt - 1),
      );
      const jitter = Math.floor(Math.random() * Math.max(1, exponentialDelay * 0.2));
      const retryAfter = options.retryAfterMs?.(error);
      await sleep(Math.max(retryAfter ?? 0, exponentialDelay + jitter), options.signal);
    }
  }
}
