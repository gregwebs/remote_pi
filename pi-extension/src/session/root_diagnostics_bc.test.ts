import type { RootEndSnapshot } from "./root_diagnostics.js";
import { beforeEach, afterEach, expect, it } from "vitest";
import { existsSync, realpathSync, mkdtempSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
const d = await import("./root_diagnostics.js");
// Capture the global setup before this file installs its own per-test sandbox.
const setupHome = process.env["REMOTE_PI_HOME"];
const setupLog = d.lifecycleLogPath();
const home = mkdtempSync(join(tmpdir(), "rp-bc-diag-"));
process.env["REMOTE_PI_HOME"] = home;
const { roomIdFor } = await import("../rooms.js");
d._setLifecycleLogPathForTest(join(home, "lifetime.log"));
let log: string;
let seq = 0;
beforeEach(async () => { await d._flushLifecycleLogForTest(); log = join(home, `${++seq}.log`); d._setLifecycleLogPathForTest(log); d._resetRootDiagnosticsForTest(); });
afterEach(async () => { await d._flushLifecycleLogForTest(); d._setLifecycleLogPathForTest(join(home, "lifetime.log")); });
const base = { lifecycleCurrent: true, lockHeld: true, configExists: true, autoStartRelay: true, meshJoined: true, relayStarted: true };
it.each([
    [{ disposed: true }, { result: "stale", reason: "disposed" }],
    [{ meshJoined: false, join: { result: "failed", reason: "join_failed", detail: "bad" } }, { result: "failed", reason: "join_not_published", detail: "join_failed: bad" }],
    [{ relayStarted: false, relay: { result: "failed", reason: "relay_timeout" } }, { result: "failed", reason: "relay_timeout", detail: "relay_timeout" }],
    [{ relayStarted: false, relay: { result: "stale", reason: "lifecycle_superseded" } }, { result: "failed", reason: "relay_not_started", detail: "lifecycle_superseded" }],
    [{ configExists: false, configDetail: "no_interactive_ui" }, { result: "failed", reason: "no_local_config", detail: "no_interactive_ui" }],
    [{ relay: { result: "ok", reason: "relay_connected" } }, { result: "ok", reason: "connected" }],
])("classifies owned snapshot %#", (patch, expected) => { expect(d.classifyRootEnd({ ...base, ...patch } as RootEndSnapshot)).toEqual(expected); });
it("direct outcomes select memory but child ends/fallback do not", () => { for (const kind of ["join_attempt", "relay_start"] as const) {
    const id = d.allocateOutcomeId();
    d.recordLifecycle({ event: `${kind}_begin`, outcomeId: id });
    expect(d.lastRootOutcome()?.result).toBe("pending");
    d.recordLifecycle({ event: `${kind}_end`, outcomeId: id, result: "failed", reason: "exception" });
    expect(d.lastRootOutcome()?.reason).toBe("exception");
} const before = d.lastRootOutcome(); for (const event of ["join_end", "relay_connect_end", "lock_fallback"] as const)
    d.recordLifecycle({ event, result: "ok" }); expect(d.lastRootOutcome()).toBe(before); });
it("late old end/stage is logged but cannot demote newer root", async () => { const a = d.allocateOutcomeId(), b = d.allocateOutcomeId(); d.recordLifecycle({ event: "root_begin", outcomeId: a }); d.recordLifecycle({ event: "root_begin", outcomeId: b }); const pending = d.lastRootOutcome(); d.recordLifecycle({ event: "root_end", outcomeId: a, result: "stale" }); d.recordLifecycle({ event: "join_begin", outcomeId: a }); expect(d.lastRootOutcome()).toBe(pending); d.recordLifecycle({ event: "root_end", outcomeId: b, result: "ok", reason: "connected" }); const done = d.lastRootOutcome(); d.recordLifecycle({ event: "root_end", outcomeId: a }); expect(d.lastRootOutcome()).toBe(done); await d._flushLifecycleLogForTest(); expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(6); });
it("cross-kind ordering and stale waiter cannot demote direct owner", () => { const a = d.allocateOutcomeId(), b = d.allocateOutcomeId(); d.recordLifecycle({ event: "root_begin", outcomeId: a }); d.recordLifecycle({ event: "relay_start_begin", outcomeId: b }); const current = d.lastRootOutcome(); d.recordLifecycle({ event: "root_wait_end", outcomeId: a, result: "stale" }); d.recordLifecycle({ event: "root_end", outcomeId: a, result: "stale" }); expect(d.lastRootOutcome()).toBe(current); d.recordLifecycle({ event: "relay_start_end", outcomeId: b, result: "ok", reason: "relay_connected" }); expect(d.lastRootOutcome()?.reason).toBe("relay_connected"); });
it("global setup isolates lifecycle paths; fallback formatter and display path", () => {
    expect(setupHome).toBeTruthy();
    expect(existsSync(setupHome!)).toBe(true);
    expect(setupLog).toBe(join(setupHome!, ".pi", "remote", "logs", "remote-pi.log"));
    expect(setupLog).not.toBe(join(homedir(), ".pi", "remote", "logs", "remote-pi.log"));
    expect(d.displayPath(join(homedir(), "lock"))).toBe("~/lock"); const f = { requested: "a", effective: "a#3", ownerLockPath: "/tmp/owner" }; expect(d.formatLockFallbackLine(f)).toContain('running as "a#3" — "a"'); expect(d.formatLockFallbackLine({ ...f, room: "room" })).toContain("identity room room"); });
it("pure identity rooms match existing derivation", () => { for (const assigned of ["folder", "custom", "folder#2"])
    expect(d.identityRoom("/missing/folder", "folder", assigned)).toBe(roomIdFor("/missing/folder", assigned)); expect(d.identityRoom("C:\\folder", "folder", "custom")).toHaveLength(12); });
it("symlink default name comes from original cwd", () => { const target = join(home, "target"), link = join(home, "alias"); mkdirSync(target); symlinkSync(target, link); for (const name of ["alias", "alias#3"])
    expect(d.identityRoom(realpathSync(target), "alias", name)).toBe(roomIdFor(link, name)); });
