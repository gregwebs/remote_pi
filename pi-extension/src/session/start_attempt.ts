import { AsyncLocalStorage } from "node:async_hooks";

export interface StartAttempt {
  candidate?: object;
  connectResult?: { result: "ok" } | { result: "failed"; error: unknown };
}
const storage = new AsyncLocalStorage<StartAttempt>();
export function withStartAttempt<T>(attempt: StartAttempt, fn: () => T): T { return storage.run(attempt, fn); }
/** Capture the store at entry, never the context of a later completion. */
export function captureStartConnect(candidate: object): (result: NonNullable<StartAttempt["connectResult"]>) => void {
  const attempt = storage.getStore();
  if (attempt) attempt.candidate = candidate;
  return result => { if (attempt) attempt.connectResult = result; };
}
