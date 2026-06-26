function defaultFormatError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "请求失败";
}

export interface SettleAllResult<M extends Record<string, Promise<unknown>>> {
  /** One value per key: fulfilled → value, rejected → null. */
  data: { [K in keyof M]: Awaited<M[K]> | null };
  /** Only the rejected keys → their formatted error message. */
  errors: Partial<Record<keyof M, string>>;
}

/**
 * Concurrently resolve a map of `key → Promise` (Promise.allSettled): a single
 * failure never drags down the others. Returns `{ data, errors }` — fulfilled
 * keys carry their value, rejected keys are null with the reason collected in
 * `errors`. Powers the "one dashboard from many endpoints" pattern.
 */
export async function settleAll<M extends Record<string, Promise<unknown>>>(
  tasks: M,
  formatError: (reason: unknown) => string = defaultFormatError,
): Promise<SettleAllResult<M>> {
  const keys = Object.keys(tasks) as Array<keyof M>;
  const settled = await Promise.allSettled(keys.map((key) => tasks[key]));

  const data = {} as { [K in keyof M]: Awaited<M[K]> | null };
  const errors: Partial<Record<keyof M, string>> = {};

  keys.forEach((key, index) => {
    const result = settled[index];
    if (result.status === "fulfilled") {
      data[key] = result.value as Awaited<M[typeof key]>;
    } else {
      data[key] = null;
      errors[key] = formatError(result.reason);
    }
  });

  return { data, errors };
}
