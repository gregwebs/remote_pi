export const ROOT_IN_FLIGHT_WAIT_MS = 500;
export const RELAY_CONNECT_TIMEOUT_MS = 20_000;

let overrides: Partial<ReturnType<typeof rootDeadlines>> = {};
export function rootDeadlines(): { inFlightWaitMs: number; relayConnectMs: number } {
  return { inFlightWaitMs: ROOT_IN_FLIGHT_WAIT_MS, relayConnectMs: RELAY_CONNECT_TIMEOUT_MS, ...overrides };
}
export function _setRootDeadlinesForTest(value: Partial<ReturnType<typeof rootDeadlines>> | null): void {
  if (value && Object.values(value).some(n => !Number.isFinite(n) || n <= 0)) throw new RangeError("Deadline must be positive");
  if (value?.inFlightWaitMs !== undefined && value.inFlightWaitMs >= 1000) throw new RangeError("Root wait must be <1000ms");
  overrides = value ?? {};
}
export function formatDuration(ms: number): string { return `${ms / 1000}s`; }
export class ConnectTimeoutError extends Error {
  readonly reason = "relay_timeout";
  constructor(readonly timeoutMs: number) {
    super(`relay connect timed out after ${formatDuration(timeoutMs)} (reason=relay_timeout)`);
    this.name = "ConnectTimeoutError";
  }
}
export type Settlement<T> = { state: "fulfilled"; value: T } | { state: "rejected"; error: unknown };
export function settle<T>(promise: Promise<T>): Promise<Settlement<T>> {
  return promise.then(value => ({ state: "fulfilled", value }), error => ({ state: "rejected", error }));
}
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settlement<T> | { state: "pending" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([settle(promise), new Promise<{ state: "pending" }>(resolve => {
      timer = setTimeout(() => resolve({ state: "pending" }), ms);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}
