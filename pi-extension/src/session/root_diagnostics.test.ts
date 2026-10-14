import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as asyncFs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetRootDiagnosticsForTest, _setLifecycleLogPathForTest, _flushLifecycleLogForTest, appendLifecycleLog,
  classifyRootEnd, errorText, formatRootOutcomeLine, lastRootOutcome,
  lifecycleLogPath, recordLifecycle, type RootEndSnapshot,
} from "./root_diagnostics.js";

// Wrap the immutable Node ESM export so failures/pending writes can be exercised.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

let home: string;
let savedHome: string | undefined;
const homes: string[] = [];
const newHome = () => {
  const path = mkdtempSync(join(tmpdir(), "pi-rootdiag-"));
  homes.push(path);
  return path;
};
beforeEach(async () => {
  await _flushLifecycleLogForTest();
  savedHome = process.env["REMOTE_PI_HOME"];
  home = newHome();
  process.env["REMOTE_PI_HOME"] = home;
  _setLifecycleLogPathForTest(null);
  _resetRootDiagnosticsForTest();
});
afterEach(async () => {
  await _flushLifecycleLogForTest();
  vi.mocked(asyncFs.appendFile).mockClear();
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env["REMOTE_PI_HOME"];
  else process.env["REMOTE_PI_HOME"] = savedHome;
  _setLifecycleLogPathForTest(null);
  for (const dir of homes.splice(0)) {
    try { chmodSync(join(dir, ".pi", "remote", "logs"), 0o755); } catch { /* may not exist */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
const readLines = (p = lifecycleLogPath()) =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);

describe("plan/70 root diagnostics", () => {
  test("U1 call-time path policy", () => {
    expect(lifecycleLogPath()).toBe(join(home, ".pi", "remote", "logs", "remote-pi.log"));
    process.env["REMOTE_PI_HOME"] = newHome();
    expect(lifecycleLogPath()).toBe(join(process.env["REMOTE_PI_HOME"]!, ".pi", "remote", "logs", "remote-pi.log"));
  });
  test("U2 override/null", () => {
    _setLifecycleLogPathForTest("/tmp/x.log");
    expect(lifecycleLogPath()).toBe("/tmp/x.log");
    _setLifecycleLogPathForTest(null);
    expect(lifecycleLogPath()).toContain(home);
  });
  test("U3 JSON stamps and lockPath schema", async () => {
    recordLifecycle({ event: "root_begin", generation: 2, cwd: "/w", detail: undefined }, Date.parse("2026-10-14T18:03:11.402Z"));
    await _flushLifecycleLogForTest();
    expect(readLines()).toEqual([{ ts: "2026-10-14T18:03:11.402Z", pid: process.pid, event: "root_begin", generation: 2, cwd: "/w" }]);
    recordLifecycle({ event: "lock_result", lockPath: "/lock", result: "refused" });
    await _flushLifecycleLogForTest();
    expect(readLines()[1]).toMatchObject({ lockPath: "/lock", result: "refused" });
    expect(readLines()[1]).not.toHaveProperty("detail");
  });
  test("U3b append order", async () => {
    for (const event of ["root_begin", "join_begin", "join_end"] as const) recordLifecycle({ event });
    await _flushLifecycleLogForTest();
    expect(readLines().map(e => e.event)).toEqual(["root_begin", "join_begin", "join_end"]);
  });
  test("U4 ENOTDIR never throws; memory first", async () => {
    writeFileSync(join(home, ".pi"), "x");
    expect(() => recordLifecycle({ event: "root_begin" })).not.toThrow();
    expect(lastRootOutcome()).toMatchObject({ result: "pending" });
    await expect(appendLifecycleLog({ event: "root_begin", ts: "x", pid: 1 })).resolves.toBeUndefined();
    await _flushLifecycleLogForTest();
  });
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("U5 read-only directory", async () => {
    const dir = join(home, ".pi", "remote", "logs");
    mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o555);
    expect(() => recordLifecycle({ event: "root_begin" })).not.toThrow();
    await _flushLifecycleLogForTest();
    expect(existsSync(lifecycleLogPath())).toBe(false);
    expect(lastRootOutcome()).toMatchObject({ result: "pending" });
  });
  test("U6 hostile errors and truncation", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    const e = new Error(""); e.name = "X";
    expect(errorText(e)).toBe("X"); expect(errorText(42)).toBe("42");
    expect(errorText({ toString() { throw new Error(); } })).toBe("<unprintable error>");
    expect(errorText(new Error("x".repeat(1000)))).toHaveLength(300);
  });
  test("U7 pending refinements/finalization", () => {
    recordLifecycle({ event: "root_begin" }, 1000);
    expect(lastRootOutcome()).toEqual({ at: 1000, result: "pending", reason: "root_in_progress" });
    recordLifecycle({ event: "join_begin" }, 5000);
    expect(lastRootOutcome()).toEqual({ at: 1000, result: "pending", reason: "joining_mesh" });
    recordLifecycle({ event: "relay_connect_begin" }, 6000);
    expect(lastRootOutcome()).toEqual({ at: 1000, result: "pending", reason: "connecting_relay" });
    recordLifecycle({ event: "root_end", result: "failed", reason: "relay_not_started" }, 9000);
    expect(lastRootOutcome()).toEqual({ at: 9000, result: "failed", reason: "relay_not_started" });
  });
  test.each(["ok", "stale", "refused", undefined] as const)("U8 end mapping %s", result => {
    recordLifecycle({ event: "root_end", result, detail: "d" }, 1);
    expect(lastRootOutcome()).toEqual({ at: 1, result: result === "ok" || result === "stale" ? result : "failed", reason: "unknown", detail: "d" });
    recordLifecycle({ event: "root_end" }, 2);
    expect(lastRootOutcome()).not.toHaveProperty("detail");
  });
  test("U9 skip and non-outcome events", () => {
    recordLifecycle({ event: "session_start_autoinit", decision: "skip", reason: "no_cwd", detail: "d" }, 1);
    const expected = { at: 1, result: "skipped", reason: "no_cwd", detail: "d" };
    expect(lastRootOutcome()).toEqual(expected);
    recordLifecycle({ event: "session_start_autoinit", decision: "skip", reason: "already_inited" });
    recordLifecycle({ event: "session_start_autoinit", decision: "start" });
    for (const event of ["command", "lock_result", "join_end", "relay_connect_end", "root_wait_begin", "root_wait_end"] as const) recordLifecycle({ event });
    expect(lastRootOutcome()).toEqual(expected);
  });
  test("U9b nonpending refinements", () => {
    recordLifecycle({ event: "join_begin" }); expect(lastRootOutcome()).toBeNull();
    recordLifecycle({ event: "session_start_autoinit", decision: "skip", reason: "no_cwd" });
    recordLifecycle({ event: "relay_connect_begin" }); expect(lastRootOutcome()?.result).toBe("skipped");
  });
  const base: RootEndSnapshot = { lifecycleCurrent: true, lockHeld: true, configExists: true, autoStartRelay: true, meshJoined: true, relayStarted: true };
  test.each([
    [{ error: { value: new Error("boom") } }, "failed", "exception", "boom"],
    [{ lifecycleCurrent: false }, "stale", "lifecycle_superseded"],
    [{ lockHeld: false }, "failed", "lock_refused"],
    [{ configExists: false }, "failed", "no_local_config"],
    [{ meshJoined: false }, "failed", "join_not_published"],
    [{}, "ok", "connected"],
    [{ relayStarted: false }, "failed", "relay_not_started"],
    [{ relayStarted: false, autoStartRelay: false }, "ok", "relay_disabled"],
  ] as const)("U10 classifier %j", (patch, result, reason, detail) => {
    expect(classifyRootEnd({ ...base, ...patch })).toEqual({ result, reason, ...(detail ? { detail } : {}) });
  });
  test.each([
    [{ error: { value: "e" }, lifecycleCurrent: false }, "exception"],
    [{ lifecycleCurrent: false, lockHeld: false }, "lifecycle_superseded"],
    [{ lockHeld: false, configExists: false }, "lock_refused"],
    [{ configExists: false, meshJoined: false }, "no_local_config"],
    [{ autoStartRelay: false }, "connected"],
    [{ error: { value: undefined } }, "exception"],
  ] as const)("U10b precedence %j", (patch, reason) => {
    const r = classifyRootEnd({ ...base, ...patch }); expect(r.reason).toBe(reason);
    if ("error" in patch && patch.error.value === undefined) expect(r.detail).toBe("undefined");
  });
  test("U11 format ages, pending, skipped, detail", () => {
    const o = { at: 1000, result: "failed" as const, reason: "relay_not_started" };
    expect(formatRootOutcomeLine(o, 13000, "/tmp/x.log")).toBe("⚠️ Last start: failed — relay_not_started (12s ago) · log: /tmp/x.log");
    expect(formatRootOutcomeLine(o, 181000)).toContain("(3m ago)");
    expect(formatRootOutcomeLine(o, 7201000)).toContain("(2h ago)");
    expect(formatRootOutcomeLine(o, 0)).toContain("(0s ago)");
    expect(formatRootOutcomeLine({ ...o, result: "pending", reason: "connecting_relay" }, 301000)).toContain("still running — connecting_relay (for 5m)");
    expect(formatRootOutcomeLine({ ...o, result: "skipped", reason: "no_cwd", detail: "d" }, 13000)).toContain("skipped — no_cwd: d (12s ago)");
    expect(formatRootOutcomeLine({ ...o, detail: "x".repeat(1000) }, 13000)).toContain("x".repeat(79) + "… (12s ago)");
  });
  test("U12 home abbreviation", () => {
    const o = { at: 0, result: "ok" as const, reason: "connected" };
    expect(formatRootOutcomeLine(o, 0, join(homedir(), ".pi/remote/logs/remote-pi.log"))).toContain("log: ~/.pi/remote/logs/remote-pi.log");
    expect(formatRootOutcomeLine(o, 0, "/tmp/x.log")).toContain("log: /tmp/x.log");
  });
  test("U13 reset only memory", async () => {
    _setLifecycleLogPathForTest(join(home, "x.log")); recordLifecycle({ event: "root_begin" });
    _resetRootDiagnosticsForTest(); expect(lastRootOutcome()).toBeNull(); expect(lifecycleLogPath()).toBe(join(home, "x.log"));
    await _flushLifecycleLogForTest();
    expect(readLines()[0]).toMatchObject({ event: "root_begin" });
  });
  test("U14 enqueue destination/time survives override, env and reset", async () => {
    const a = join(home, "a.log"), b = join(newHome(), "b.log");
    _setLifecycleLogPathForTest(a);
    const input = { event: "root_begin" as const, cwd: "/original" };
    recordLifecycle(input, 1000);
    input.cwd = "/mutated";
    _setLifecycleLogPathForTest(b); process.env["REMOTE_PI_HOME"] = newHome();
    _resetRootDiagnosticsForTest();
    await _flushLifecycleLogForTest();
    expect(readLines(a)).toEqual([{ event: "root_begin", cwd: "/original", ts: new Date(1000).toISOString(), pid: process.pid }]);
    expect(existsSync(b)).toBe(false);
  });
  test("U15 deferred consecutive-path batches persist before root completion", async () => {
    const a = join(home, "a.log"), b = join(home, "b.log");
    const append = vi.spyOn(asyncFs, "appendFile");
    _setLifecycleLogPathForTest(a); recordLifecycle({ event: "root_begin" }); recordLifecycle({ event: "join_begin" });
    expect(append).not.toHaveBeenCalled(); expect(lastRootOutcome()?.reason).toBe("joining_mesh");
    _setLifecycleLogPathForTest(b); recordLifecycle({ event: "command" });
    _setLifecycleLogPathForTest(a); recordLifecycle({ event: "lock_result" });
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(3));
    await _flushLifecycleLogForTest();
    expect(append.mock.calls.map(c => c[0])).toEqual([a,b,a]);
    expect(readLines(a).map(e => e.event)).toEqual(["root_begin", "join_begin", "lock_result"]);
    expect(lastRootOutcome()?.result).toBe("pending");
  });
  test("U16 failed serialization/mkdir/append does not block later paths", async () => {
    const bad = join(home, "file"); writeFileSync(bad, "x");
    _setLifecycleLogPathForTest(join(bad, "log")); recordLifecycle({ event: "root_begin" });
    const good = join(home, "good.log"); _setLifecycleLogPathForTest(good);
    const append = vi.spyOn(asyncFs, "appendFile").mockRejectedValueOnce(new Error("ENOSPC"));
    recordLifecycle({ event: "join_begin" });
    await expect(_flushLifecycleLogForTest()).resolves.toBeUndefined();
    const hostile = { event: "command" as const, toJSON() { throw new Error("serialize"); } };
    recordLifecycle(hostile); recordLifecycle({ event: "root_end", result: "ok", reason: "connected" });
    await expect(_flushLifecycleLogForTest()).resolves.toBeUndefined();
    expect(readLines(good).map(e => e.event)).toEqual(["root_end"]);
    expect(lastRootOutcome()?.reason).toBe("connected"); expect(append).toHaveBeenCalledTimes(2);
  });
  test("U17 concurrent flushes include arrivals while append is pending", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).appendFile;
    const append = vi.spyOn(asyncFs, "appendFile").mockImplementationOnce(async (...args) => { await held; await original(...args); });
    recordLifecycle({ event: "root_begin" });
    const first = _flushLifecycleLogForTest(), second = _flushLifecycleLogForTest();
    try {
      await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
      recordLifecycle({ event: "join_begin" }); _resetRootDiagnosticsForTest();
    } finally { release(); await Promise.all([first,second]); }
    expect(readLines().map(e => e.event)).toEqual(["root_begin", "join_begin"]);
    expect(lastRootOutcome()).toBeNull();
    await expect(_flushLifecycleLogForTest()).resolves.toBeUndefined();
  });
});
