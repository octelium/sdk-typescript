import { OcteliumError } from "./errors.js";

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export function timeout(value: number, allowZero = true): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 2_147_483_647
  )
    throw new OcteliumError(
      "Invalid timeout in milliseconds",
      "INVALID_ARGUMENT",
    );
  return value;
}

export class Operation {
  readonly signal: AbortSignal;
  readonly deadline: Date | undefined;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    lifetime: AbortSignal,
    milliseconds: number,
    signal?: AbortSignal,
  ) {
    timeout(milliseconds);
    this.signal = AbortSignal.any([
      lifetime,
      this.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    this.deadline = milliseconds
      ? new Date(Date.now() + milliseconds)
      : undefined;
    if (milliseconds)
      this.timer = setTimeout(
        () =>
          this.controller.abort(
            new OcteliumError("Operation timed out", "DEADLINE_EXCEEDED"),
          ),
        milliseconds,
      );
  }

  close(): void {
    clearTimeout(this.timer);
  }
}

export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
