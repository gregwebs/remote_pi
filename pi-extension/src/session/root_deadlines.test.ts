import { afterEach, expect, it, vi } from "vitest";
import { _setRootDeadlinesForTest, ConnectTimeoutError, rootDeadlines, settleWithin } from "./root_deadlines.js";
import { captureStartConnect, withStartAttempt, type StartAttempt } from "./start_attempt.js";
afterEach(() => { vi.useRealTimers(); _setRootDeadlinesForTest(null); });
it("early fulfillment clears timer", async () => { vi.useFakeTimers(); expect(await settleWithin(Promise.resolve(7), 500)).toEqual({ state: "fulfilled", value: 7 }); expect(vi.getTimerCount()).toBe(0); });
it("early rejection preserves even undefined", async () => { vi.useFakeTimers(); for (const error of [{}, undefined]) {
    expect(await settleWithin(Promise.reject(error), 500)).toEqual({ state: "rejected", error });
} expect(vi.getTimerCount()).toBe(0); });
it("pending deadline observes late completion and rejection", async () => { vi.useFakeTimers(); for (const reject of [false, true]) {
    let finish!: () => void;
    const p = new Promise<void>((res, rej) => { finish = reject ? rej : res; });
    const result = settleWithin(p, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({ state: "pending" });
    finish();
    await Promise.resolve();
} expect(vi.getTimerCount()).toBe(0); });
it("defaults, overrides, reset and validation", () => { expect(rootDeadlines()).toEqual({ inFlightWaitMs: 500, relayConnectMs: 20000 }); _setRootDeadlinesForTest({ inFlightWaitMs: 25 }); expect(rootDeadlines().inFlightWaitMs).toBe(25); for (const n of [0, -1, 1000, NaN])
    expect(() => _setRootDeadlinesForTest({ inFlightWaitMs: n })).toThrow(); _setRootDeadlinesForTest(null); expect(rootDeadlines().inFlightWaitMs).toBe(500); });
it("typed relay error carries duration", () => { const e = new ConnectTimeoutError(50); expect(e).toMatchObject({ name: "ConnectTimeoutError", reason: "relay_timeout", timeoutMs: 50 }); expect(e.message).toContain("0.05s"); });
it("concurrent async stores capture independent callbacks", async () => { const a: StartAttempt = {}, b: StartAttempt = {}; const ca = {}, cb = {}; const one = withStartAttempt(a, async () => { await Promise.resolve(); return captureStartConnect(ca); }); const two = withStartAttempt(b, async () => { await Promise.resolve(); return captureStartConnect(cb); }); const [fa, fb] = await Promise.all([one, two]); const error = {}; fb({ result: "failed", error }); fa({ result: "ok" }); captureStartConnect({})({ result: "failed", error: 4 }); expect(a).toEqual({ candidate: ca, connectResult: { result: "ok" } }); expect(b).toEqual({ candidate: cb, connectResult: { result: "failed", error } }); });
