export class AbortedError extends Error {
  public constructor() {
    super("Operation aborted");
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortedError();
  }
}

export async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);

    const abort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };

    signal?.addEventListener("abort", abort, { once: true });

    if (signal) {
      setTimeout(() => signal.removeEventListener("abort", abort), milliseconds + 1);
    }
  });
}

export function randomInteger(minimum: number, maximum: number): number {
  const lower = Math.ceil(Math.min(minimum, maximum));
  const upper = Math.floor(Math.max(minimum, maximum));
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortedError ||
    (error instanceof Error && error.name === "AbortError")
  );
}
