import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LifecycleEvent } from "./session/root_diagnostics.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const home = mkdtempSync(join(tmpdir(), "rp-bc-"));
process.env["REMOTE_PI_HOME"] = home;
const instances: MockRelay[] = [];
let connectImpl: (client: MockRelay, opts?: unknown) => Promise<void> = async () => { };
const { captureStartConnect } = await import("./session/start_attempt.js");
class MockRelay extends EventEmitter {
    readyState = 1;
    connect = vi.fn(async (opts?: unknown) => {
        const observe = captureStartConnect(this);
        try {
            await connectImpl(this, opts);
            observe({ result: "ok" });
        }
        catch (error) {
            observe({ result: "failed", error });
            throw error;
        }
    });
    close = vi.fn(() => { this.readyState = 3; });
    send = vi.fn();
    sendControl = vi.fn();
    isOpen = () => this.readyState === 1;
    constructor() { super(); instances.push(this); }
}
class RoomAlreadyOpenError extends Error {
}
vi.mock("node:fs", async (orig) => { const fs = await orig<typeof import("node:fs")>(); return { ...fs, realpathSync: vi.fn(fs.realpathSync) }; });
vi.mock("./transport/relay_client.js", () => ({ RelayClient: MockRelay, RoomAlreadyOpenError }));
vi.mock("./pairing/storage.js", async (orig) => ({
    ...await orig<typeof import("./pairing/storage.js")>(),
    getOrCreateEd25519Keypair: vi.fn(async () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) })),
    listPeers: vi.fn(async () => []), listOwnerPubkeys: vi.fn(async () => []),
    snapshotOwnerPubkeys: vi.fn(async () => []), conditionalRemovePeer: vi.fn(),
    addPeer: vi.fn(), removePeer: vi.fn(),
}));
vi.mock("./config.js", async (orig) => ({ ...await orig<typeof import("./config.js")>(), loadConfig: () => ({}), saveConfig: vi.fn(), resolveRelayUrl: () => ({ url: "https://relay.test", source: "config" }) }));
vi.mock("./session/setup_wizard.js", async (orig) => ({ ...await orig<typeof import("./session/setup_wizard.js")>(), runSetupWizard: vi.fn(async () => null) }));
const diag = await import("./session/root_diagnostics.js");
diag._setLifecycleLogPathForTest(join(home, "lifetime.log"));
const ext = await import("./index.js");
const storage = await import("./pairing/storage.js");
const locks = await import("./session/cwd_lock.js");
const { MeshNode } = await import("./session/mesh_node.js");
const realMeshConnect = MeshNode.prototype.connect;
const deadlines = await import("./session/root_deadlines.js");
const { roomIdFor } = await import("./rooms.js");
const keypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
type Ctx = ReturnType<typeof makeMockCtx>;
type Handler = (args: string, ctx: Ctx) => Promise<void>;
let handlers: Map<string, Handler>, eventHandlers: Map<string, (event: unknown, ctx?: unknown) => unknown>;
function captureHandler(name: string): Handler { const handler = handlers.get(name); if (!handler)
    throw new Error(name); return handler; }
function captureEventHandler(name: string) { const handler = eventHandlers.get(name); if (!handler)
    throw new Error(name); return handler; }
function makeMockCtx(cwd = testCwd) { return { cwd, ui: { notify: vi.fn() }, abort: vi.fn() }; }
const drains: Promise<unknown>[] = [], releases: Array<() => void> = [];
function observe<T>(p: Promise<T>): Promise<T> { drains.push(p.catch(() => undefined)); return p; }
function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (error?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    releases.push(() => resolve(undefined as T));
    return { promise, resolve, reject };
}
let testCwd: string, logPath: string, sequence = 0;
const argv = process.argv;
const savedDirect = process.env["REMOTE_PI_DIRECT_CONFIG"];
const savedDaemon = process.env["REMOTE_PI_DAEMON"];
function configure(auto = true) { process.env["REMOTE_PI_DIRECT_CONFIG"] = JSON.stringify({ agent_name: "agent", auto_start_relay: auto }); }
function run(args = "", ctx = makeMockCtx()) { return observe(captureHandler("remote-pi")(args, ctx)); }
function auto(ctx = makeMockCtx()) { captureEventHandler("session_start")({ type: "session_start" }, ctx); const p = ext._getRootInFlightForTest(); if (p)
    observe(p); }
async function finished() { const p = ext._getRootInFlightForTest(); if (p)
    await p; await Promise.resolve(); await diag._flushLifecycleLogForTest(); }
async function events() { await diag._flushLifecycleLogForTest(); return existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as LifecycleEvent) : []; }
function messages(ctx: Ctx, level?: string) { return ctx.ui.notify.mock.calls.filter(c => !level || c[1] === level).map(c => c[0] as string); }
function text(ctx: Ctx) { return messages(ctx).join("\n"); }
async function status() { const ctx = makeMockCtx(); await run("status", ctx); return text(ctx); }
async function stop() { await run("stop"); }
async function drain() {
    releases.splice(0).forEach(release => release());
    const pending = ext._getRootInFlightForTest();
    if (pending)
        observe(pending);
    await ext._stopForTest(makeMockCtx());
    await Promise.all(drains.splice(0));
    await Promise.resolve();
    await diag._flushLifecycleLogForTest();
    ext._resetCwdLockForTest();
    expect(ext._getRootInFlightForTest()).toBeNull();
    expect(ext._hasMeshNodeForTest()).toBe(false);
    expect(ext._getLockedNameForTest()).toBeNull();
    if (logPath)
        for (const e of await events())
            if (e.event === "lock_result" && e.result === "ok" && typeof e.lockPath === "string" && e.lockPath.endsWith(".sock"))
                await vi.waitFor(() => expect(existsSync(e.lockPath!)).toBe(false));
}
beforeEach(async () => {
    await diag._flushLifecycleLogForTest();
    logPath = join(home, `test-${++sequence}.log`);
    diag._setLifecycleLogPathForTest(logPath);
    diag._resetRootDiagnosticsForTest();
    vi.clearAllMocks();
    instances.length = 0;
    connectImpl = async () => { };
    vi.mocked(storage.getOrCreateEd25519Keypair).mockResolvedValue(keypair);
    ext._setDisposedForTest(false);
    ext._resetAutoInitedForTest();
    process.argv = ["node", "pi"];
    delete process.env["REMOTE_PI_DAEMON"];
    delete process.env["REMOTE_PI_DIRECT_CONFIG"];
    testCwd = mkdtempSync(join(home, "cwd-"));
    handlers = new Map();
    eventHandlers = new Map();
    ext.default({ on: (name: string, fn: (e: unknown, ctx?: unknown) => unknown) => eventHandlers.set(name, fn), registerCommand: (name: string, opts: {
            handler: Handler;
        }) => handlers.set(name, opts.handler),
        registerTool() { }, registerShortcut() { }, registerFlag() { }, getFlag() { }, registerMessageRenderer() { }, sendMessage() { }, sendUserMessage() { } } as unknown as ExtensionAPI);
});
afterEach(async () => {
    try {
        await drain();
        expect(ext._hasPendingReconnect()).toBe(false);
    }
    finally {
        await diag._flushLifecycleLogForTest();
        diag._setLifecycleLogPathForTest(join(home, "lifetime.log"));
        vi.restoreAllMocks();
        vi.useRealTimers();
        deadlines._setRootDeadlinesForTest(null);
        process.argv = argv;
        if (savedDirect === undefined)
            delete process.env["REMOTE_PI_DIRECT_CONFIG"];
        else
            process.env["REMOTE_PI_DIRECT_CONFIG"] = savedDirect;
        if (savedDaemon === undefined)
            delete process.env["REMOTE_PI_DAEMON"];
        else
            process.env["REMOTE_PI_DAEMON"] = savedDaemon;
        ext._setDisposedForTest(false);
        ext._resetAutoInitedForTest();
    }
});
function gateJoin() {
    const gate = deferred<string>();
    vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(() => gate.promise);
    return gate;
}
async function incumbent() { const lock = await locks.acquireCwdLock(testCwd, "agent"); if (!lock.ok)
    throw new Error("fixture incumbent refused"); releases.push(() => lock.release()); return lock; }
async function pendingRoot(ctx = makeMockCtx()) { const gate = gateJoin(); const p = run("", ctx); await vi.waitFor(() => expect(ext._getLockedNameForTest()).not.toBeNull()); return { gate, p, ctx }; }
test("D1 no config/noninteractive reports reason", async () => { const ctx = makeMockCtx(); await run("", ctx); expect(text(ctx)).toContain("no_interactive_ui"); expect(messages(ctx, "warning")).toHaveLength(1); expect((await events()).at(-1)).toMatchObject({ event: "root_end", result: "failed", reason: "no_local_config", detail: "no_interactive_ui" }); });
test("D2 stale join rejection after stop", async () => { configure(); const { gate, p, ctx } = await pendingRoot(); await stop(); ctx.ui.notify.mockClear(); gate.reject(new Error("obsolete")); await p; expect(messages(ctx, "warning")).toHaveLength(1); expect(text(ctx)).toContain("lifecycle_superseded"); expect(await status()).toContain("stale"); expect(ext._hasMeshNodeForTest()).toBe(false); });
test.each([["user", false], ["user", true], ["auto", false], ["auto", true], ["auto", "stale"]] as const)("D3 %s %s reporting", async (origin, failure) => {
    configure();
    const ctx = makeMockCtx();
    if (failure === "stale") {
        const g = gateJoin();
        auto(ctx);
        await vi.waitFor(() => expect(ext._getLockedNameForTest()).not.toBeNull());
        await stop();
        ctx.ui.notify.mockClear();
        g.reject(new Error("obsolete"));
        await finished();
    }
    else {
        if (failure)
            connectImpl = async () => { throw new Error("ECONNREFUSED"); };
        if (origin === "auto") {
            auto(ctx);
            await finished();
        }
        else
            await run("", ctx);
    }
    expect(messages(ctx, "warning")).toHaveLength(0);
    expect(messages(ctx, "error")).toHaveLength(failure === true ? 1 : 0);
    if (!failure)
        expect(messages(ctx).filter(m => m.startsWith("[remote-pi]\n"))).toHaveLength(1);
});
test("D4 real lock fallback publishes owner/effective identity and active room", async () => { configure(); const owner = await incumbent(), ctx = makeMockCtx(); await run("", ctx); const es = await events(), acquired = es.find(e => e.event === "lock_result" && e.result === "ok")!; expect(acquired.lockPath).not.toBe(owner.lockPath); expect(text(ctx)).toContain(owner.lockPath); expect(text(ctx)).toContain('This session joined as "agent#2"'); expect(text(ctx)).toContain("different identity"); const room = (instances[0]!.connect.mock.calls[0]![0] as {
    roomId: string;
}).roomId; expect(await status()).toContain(`identity room ${room}`); expect(es.at(-1)).toMatchObject({ name: "agent#2", room, result: "ok" }); expect(es.filter(e => e.event === "lock_result")).toHaveLength(2); });
test("D5 auto fallback warns visibly", async () => { configure(); const owner = await incumbent(), ctx = makeMockCtx(); auto(ctx); await finished(); expect(messages(ctx, "warning")).toHaveLength(1); expect(text(ctx)).toContain(owner.lockPath); expect(text(ctx)).toContain("This session joined as"); });
test("D6 disposed root entry does no startup", async () => { ext._setDisposedForTest(true); const acquire = vi.spyOn(locks, "acquireCwdLock"), ctx = makeMockCtx(); await run("", ctx); expect(acquire).not.toHaveBeenCalled(); expect(messages(ctx, "warning")).toHaveLength(1); expect(text(ctx)).toContain("/reload"); expect((await events()).map(e => e.event)).toEqual(["root_end"]); });
test("D7 disposed relay entry does no identity or transport work", async () => { ext._setDisposedForTest(true); const ctx = makeMockCtx(); await run("relay start", ctx); expect(storage.getOrCreateEd25519Keypair).not.toHaveBeenCalled(); expect(instances).toHaveLength(0); expect(messages(ctx, "warning")).toHaveLength(1); expect((await events()).at(-1)).toMatchObject({ event: "relay_start_end", result: "stale", reason: "disposed" }); });
test("D8 disposed diagnoses each invocation", async () => { ext._setDisposedForTest(true); for (const args of ["", "", "relay start", "relay start"]) {
    const ctx = makeMockCtx();
    await run(args, ctx);
    expect(messages(ctx, "warning")).toHaveLength(1);
    expect(text(ctx)).toContain("disposed");
} });
test("D9 relay off during keychain start", async () => { const gate = deferred<typeof keypair>(); vi.mocked(storage.getOrCreateEd25519Keypair).mockImplementationOnce(() => gate.promise); const ctx = makeMockCtx(), p = run("relay start", ctx); await ext._handleControl("relay:off"); gate.resolve(keypair); await p; expect(instances).toHaveLength(0); expect(messages(ctx, "warning")).toHaveLength(1); expect(text(ctx)).toContain("lifecycle_superseded"); });
test("D10 shutdown pending acquisition releases late lock and fences UI/outcome", async () => { configure(); const gate = deferred<Awaited<ReturnType<typeof locks.acquireCwdLock>>>(); const realAcquire = locks.acquireCwdLock; vi.spyOn(locks, "acquireCwdLock").mockImplementationOnce(() => gate.promise); const ctx = makeMockCtx(), p = run("", ctx); await captureEventHandler("session_shutdown")({}); const atShutdown = ctx.ui.notify.mock.calls.length; ext._setDisposedForTest(false); const newer = makeMockCtx(); await run("", newer); const outcome = diag.lastRootOutcome(); const late = await realAcquire(testCwd, "late"); expect(late.ok).toBe(true); gate.resolve(late); await p; expect(ctx.ui.notify).toHaveBeenCalledTimes(atShutdown); expect(diag.lastRootOutcome()).toBe(outcome); if (late.ok)
    await vi.waitFor(() => expect(existsSync(late.lockPath)).toBe(false)); });
test("D11 default duplicate wait is <1s and post-stop fresh root bypasses", async () => { configure(); const old = await pendingRoot(), ctx = makeMockCtx(); const began = performance.now(); await run("", ctx); const elapsed = performance.now() - began; try {
    writeFileSync(join(home, "c1-timing.txt"), `performance.now() around await run("", duplicateCtx): ${elapsed.toFixed(2)}ms\n`, "utf8");
}
catch { /* evidence artifact only — must never affect the assertion */ } expect(elapsed).toBeLessThan(1000); expect(text(ctx)).toContain("Still connecting…"); expect(text(ctx)).toContain("joining_mesh"); expect(messages(ctx, "warning")).toHaveLength(1); await stop(); await run(); expect(ext._hasMeshNodeForTest()).toBe(true); old.gate.reject(new Error("old")); await old.p; });
test("D12 setup cancellation is sufficient explanation", async () => { const ctx = makeMockCtx(); Object.assign(ctx.ui, { select: vi.fn() }); await run("", ctx); expect(text(ctx)).toContain("Setup cancelled."); expect(messages(ctx, "warning")).toHaveLength(0); expect(text(ctx)).toContain("Local mesh"); expect((await events()).at(-1)).toMatchObject({ reason: "no_local_config", detail: "setup_cancelled" }); });
test("D13 throwing cwd preserves rejection even with throwing UI", async () => { for (const brokenUI of [false, true]) {
    const error = {}, getter = vi.fn(() => { throw error; }), ctx = makeMockCtx();
    Object.defineProperty(ctx, "cwd", { get: getter });
    if (brokenUI)
        ctx.ui.notify.mockImplementation(() => { throw new Error("dead ui"); });
    await expect(run("", ctx)).rejects.toBe(error);
    expect(getter).toHaveBeenCalledTimes(1);
    if (!brokenUI) {
        expect(text(ctx)).toContain("exception");
        expect(text(ctx)).toContain("Local mesh");
    }
} expect((await events()).map(e => e.event)).toEqual(["root_begin", "root_end", "root_begin", "root_end"]); });
async function invalidatedWait(action: "stop" | "off" | "shutdown") { configure(); const old = await pendingRoot(), ctx = makeMockCtx(); const waiter = run("", ctx); await new Promise(resolve => setTimeout(resolve, 30)); if (action === "shutdown")
    await captureEventHandler("session_shutdown")({});
else if (action === "stop")
    await stop();
else
    await ext._handleControl("relay:off"); await waiter; expect(text(ctx)).not.toContain("Still connecting"); if (action === "shutdown")
    expect(ctx.ui.notify).not.toHaveBeenCalled();
else {
    expect(messages(ctx, "warning")).toHaveLength(1);
    expect(text(ctx)).toContain("lifecycle_superseded");
} expect((await events()).filter(e => e.event === "root_begin")).toHaveLength(1); old.gate.reject(new Error("old")); await old.p; }
test("D14 stop during duplicate wait", async () => { await invalidatedWait("stop"); });
test("D15 relay off during duplicate wait does not demote newer result", async () => {
    configure();
    const old = await pendingRoot(), ctx = makeMockCtx(), waiter = run("", ctx);
    await ext._handleControl("relay:off");
    await run("relay start");
    const newer = diag.lastRootOutcome();
    await waiter;
    expect(text(ctx)).not.toContain("Still connecting");
    expect(text(ctx)).toContain("lifecycle_superseded");
    expect(diag.lastRootOutcome()).toBe(newer);
    old.gate.reject(new Error("old"));
    await old.p;
    expect(diag.lastRootOutcome()).toBe(newer);
});
test("D16 shutdown during duplicate wait never touches outgoing UI", async () => { await invalidatedWait("shutdown"); });
test("D17 simultaneous post-stop commands admit exactly one fresh owner", async () => { configure(); const old = await pendingRoot(); await stop(); ext._resetCwdLockForTest(); const before = (await events()).filter(e => e.event === "root_begin").length; const a = makeMockCtx(), b = makeMockCtx(); await Promise.all([run("", a), run("", b)]); const es = await events(); expect(es.filter(e => e.event === "root_begin")).toHaveLength(before + 1); expect(es.filter(e => e.event === "lock_result" && e.result === "ok").at(-1)?.name).toBe("agent"); expect(ext._getLockedNameForTest()).toBe("agent"); old.gate.reject(new Error("old")); await old.p; });
test("D18 replacement draining old owner coalesces with completed manual owner", async () => { configure(); const old = await pendingRoot(); await captureEventHandler("session_shutdown")({}); ext._setAutoInitedForTest(true); auto(); await run(); const newer = diag.lastRootOutcome(); old.gate.reject(new Error("old")); await old.p; await finished(); expect((await events()).filter(e => e.event === "root_begin")).toHaveLength(2); expect(diag.lastRootOutcome()).toBe(newer); });
test("D19 broker assignment wins over reserved suffix without new continuation realpath", async () => {
    configure(false);
    await incumbent();
    const expected = roomIdFor(testCwd, "agent#3");
    const gate = deferred<void>();
    vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(async function (this: InstanceType<typeof MeshNode>) { await gate.promise; vi.spyOn(this, "name").mockReturnValue("agent#3"); return "agent#3"; });
    const ctx = makeMockCtx(), p = run("", ctx);
    await vi.waitFor(() => expect(ext._getLockedNameForTest()).toBe("agent#2"));
    const calls = vi.mocked(realpathSync).mock.calls.length;
    gate.resolve();
    await p;
    expect(text(ctx)).toContain('This session joined as "agent#3"');
    expect(text(ctx)).not.toContain('This session joined as "agent#2"');
    expect(await status()).toContain(`identity room ${expected}`);
    expect(vi.mocked(realpathSync).mock.calls).toHaveLength(calls);
    const es = await events();
    expect(es.at(-1)).toMatchObject({ name: "agent#3", room: expected });
    expect(es.find(e => e.event === "lock_result" && e.result === "ok")?.name).toBe("agent#2");
});
test("D20 failed fallback join never claims publication; retry remains honest", async () => { configure(); await incumbent(); vi.spyOn(MeshNode.prototype, "connect").mockRejectedValueOnce(new Error("join broke")); const ctx = makeMockCtx(); await run("", ctx); expect(text(ctx)).toContain("join failed"); expect(text(ctx)).not.toContain("This session joined as"); expect(await status()).not.toContain("Identity:"); await run("", ctx); expect(text(ctx)).toContain('This session joined as "agent#2"'); });
test("D21 rename refreshes actual fallback identity; failed rename does not invent name", async () => { configure(false); await incumbent(); await run(); let liveName = "agent#2"; vi.spyOn(MeshNode.prototype, "name").mockImplementation(() => liveName); vi.spyOn(MeshNode.prototype, "rename").mockImplementationOnce(async () => { liveName = "renamed"; return liveName; }).mockRejectedValueOnce(new Error("rename broke")); await run("rename renamed"); expect(await status()).toContain('running as "renamed"'); expect(await status()).toContain('"agent" held by another'); expect(await status()).toContain(roomIdFor(testCwd, "renamed")); await run("rename never-published"); expect(await status()).not.toContain("never-published"); /* plan/70 B1/F1: a failed destructive rename is unpublished from its start; it must not advertise a surviving registration. The old `running as "renamed"` claim encoded the very premise F1 disproved. */ expect(await status()).not.toContain('running as "renamed"'); expect(await status()).not.toContain("connected as"); expect(ext._hasMeshNodeForTest()).toBe(false); });
async function overlappingStarts(newerFirst: boolean) { const old = deferred<typeof keypair>(), fresh = deferred<typeof keypair>(); vi.mocked(storage.getOrCreateEd25519Keypair).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise); const a = makeMockCtx(), b = makeMockCtx(), pa = run("relay start", a), pb = run("relay start", b); if (newerFirst) {
    fresh.resolve(keypair);
    await pb;
    old.resolve(keypair);
    await pa;
}
else {
    old.resolve(keypair);
    await pa;
    expect(diag.lastRootOutcome()?.result).toBe("pending");
    fresh.resolve(keypair);
    await pb;
} const es = await events(), ends = es.filter(e => e.event === "relay_start_end"); expect(ends.find(e => e.outcomeId === Math.min(...ends.map(e => e.outcomeId!)))?.result).toBe("stale"); expect(messages(a, "warning")).toHaveLength(1); expect(text(a)).toContain("lifecycle_superseded"); expect(diag.lastRootOutcome()?.reason).toBe("relay_connected"); expect(instances).toHaveLength(1); }
test("D22 newer relay succeeds before obsolete identity lookup", async () => { await overlappingStarts(true); });
test("D23 attempt-scoped timeout root records typed reason without duplicate warning", async () => { configure(); connectImpl = async () => { throw new deadlines.ConnectTimeoutError(20); }; const ctx = makeMockCtx(); await run("", ctx); expect(messages(ctx, "error")).toHaveLength(1); expect(messages(ctx, "warning")).toHaveLength(0); expect(instances[0]!.close).toHaveBeenCalled(); const es = await events(); expect(es.find(e => e.event === "relay_connect_end")?.reason).toBe("relay_timeout"); expect(es.at(-1)?.reason).toBe("relay_timeout"); expect(await status()).toContain("relay_timeout"); });
test("D24 unrelated timeout cannot contaminate current refusal", async () => { const gate = deferred<void>(); connectImpl = async (client) => { if (client === instances[0]) {
    await gate.promise;
    throw new Error("ECONNREFUSED current");
} throw new deadlines.ConnectTimeoutError(10); }; const ctx = makeMockCtx(), p = run("relay start", ctx); await vi.waitFor(() => expect(instances).toHaveLength(1)); const other = new MockRelay(); await expect(other.connect()).rejects.toBeInstanceOf(deadlines.ConnectTimeoutError); gate.resolve(); await p; expect(diag.lastRootOutcome()).toMatchObject({ reason: "relay_connect_failed", detail: "ECONNREFUSED current" }); other.close(); });
test("D25 reconnect timeout closes candidate and backoff can recover", async () => { configure(); await run(); vi.useFakeTimers(); connectImpl = async () => { throw new deadlines.ConnectTimeoutError(10); }; instances[0]!.emit("close"); await vi.advanceTimersByTimeAsync(1000); expect(instances[1]!.close).toHaveBeenCalled(); expect(ext._hasPendingReconnect()).toBe(true); connectImpl = async () => { }; await vi.advanceTimersByTimeAsync(2000); expect(instances).toHaveLength(3); expect(ext._hasPendingReconnect()).toBe(false); expect(ext._getState()).not.toBe("idle"); vi.useRealTimers(); });
test("D26 production control/pair/revoke/rename routes record direct completions", async () => {
    configure();
    connectImpl = async () => { throw new Error("refused"); };
    await ext._handleControl("relay:on");
    await ext._handleControl("relay:toggle");
    await run("pair");
    await stop();
    await run("revoke deadbeef");
    await stop();
    connectImpl = async () => { };
    await run();
    connectImpl = async () => { throw new Error("restart refused"); };
    await run("rename next");
    const es = await events();
    expect(es.filter(e => e.event === "relay_start_begin")).toHaveLength(5);
    expect(es.filter(e => e.event === "relay_start_end")).toHaveLength(5);
    expect(es.filter(e => e.event === "join_attempt_begin")).toHaveLength(2);
    expect(es.filter(e => e.event === "join_attempt_end")).toHaveLength(2);
    await stop();
    const error = {};
    vi.mocked(storage.getOrCreateEd25519Keypair).mockRejectedValueOnce(error);
    await expect(ext._handleControl("relay:on")).rejects.toBe(error);
    expect((await events()).at(-1)).toMatchObject({ event: "relay_start_end", reason: "exception" });
    connectImpl = async () => { };
    class UI {
        #alive = true;
        calls: string[] = [];
        notify(message: string) { expect(this.#alive).toBe(true); this.calls.push(message); }
        setTitle() { expect(this.#alive).toBe(true); }
        setStatus() { expect(this.#alive).toBe(true); }
    }
    class Context {
        #ui = new UI();
        get ui() { return this.#ui; }
        get cwd() { return testCwd; }
    }
    const prototypeCtx = new Context();
    await run("relay start", prototypeCtx as unknown as Ctx);
    expect(prototypeCtx.ui.calls.some(message => message.includes("Connected to relay"))).toBe(true);
});
test("D27 obsolete relay resolves while newer is still pending", async () => { await overlappingStarts(false); });
test("D28 suffix exhaustion and daemon messages retain primary owner path", async () => { configure(); const acquire = vi.spyOn(locks, "acquireCwdLock").mockImplementation(async (_cwd, name) => ({ ok: false as const, lockPath: name === "agent" ? "/primary-owner.sock" : "/other-owner.sock" })); const ctx = makeMockCtx(); await run("", ctx); expect(acquire).toHaveBeenCalledTimes(1000); expect(text(ctx)).toContain("too many agents"); expect(text(ctx)).toContain("/primary-owner.sock"); expect(text(ctx)).toContain("lock_refused"); acquire.mockClear(); process.env["REMOTE_PI_DAEMON"] = "1"; const daemon = makeMockCtx(); await run("", daemon); expect(acquire).toHaveBeenCalledTimes(1); expect(text(daemon)).toContain("Daemon not started"); expect(text(daemon)).toContain("/primary-owner.sock"); });
test("D29 current-tree disposed rearm without config warns auto failure", async () => { ext._setDisposedForTest(true); ext._setAutoInitedForTest(true); const ctx = makeMockCtx(); auto(ctx); await finished(); expect(messages(ctx, "warning")).toHaveLength(1); expect(text(ctx)).toContain("Auto-start did not finish"); expect(text(ctx)).toContain("no_interactive_ui"); });
test("D30 current auto root with superseded relay child cannot borrow newer success", async () => { configure(); const gate = deferred<typeof keypair>(); vi.mocked(storage.getOrCreateEd25519Keypair).mockImplementationOnce(() => gate.promise); const ctx = makeMockCtx(); auto(ctx); await vi.waitFor(() => expect(storage.getOrCreateEd25519Keypair).toHaveBeenCalledTimes(1)); await run("relay start"); gate.resolve(keypair); await finished(); expect(messages(ctx, "warning")).toHaveLength(1); expect(text(ctx)).toContain("relay_not_started"); expect((await events()).filter(e => e.event === "root_end").at(-1)).toMatchObject({ result: "failed", reason: "relay_not_started" }); expect(diag.lastRootOutcome()?.reason).toBe("relay_connected"); });
test("D31 failed coalescing is status-only; rejected duplicate preserves rejection", async () => { configure(); const gate = deferred<void>(); connectImpl = async () => { await gate.promise; throw new Error("refused"); }; const a = run(); await vi.waitFor(() => expect(instances).toHaveLength(1)); const ctx = makeMockCtx(), b = run("", ctx); gate.resolve(); await Promise.all([a, b]); expect(messages(ctx)).toHaveLength(1); expect(text(ctx)).toContain("relay_not_started"); const es = await events(); expect(es.findIndex(e => e.event === "root_end")).toBeLessThan(es.findIndex(e => e.event === "root_wait_end")); await stop(); ext._resetCwdLockForTest(); const kp = deferred<typeof keypair>(); vi.mocked(storage.getOrCreateEd25519Keypair).mockImplementationOnce(() => kp.promise); const owner = run(); await vi.waitFor(() => expect(ext._hasMeshNodeForTest()).toBe(true)); const other = makeMockCtx(), duplicate = run("", other), error = {}; kp.reject(error); await expect(owner).rejects.toBe(error); await expect(duplicate).rejects.toBe(error); expect(text(other)).toContain("exception"); expect((await events()).filter(e => e.event === "relay_connect_end").at(-1)).toMatchObject({ result: "failed", reason: "relay_not_started", detail: "exception: [object Object]" }); });
test("D32 late obsolete finalizer cannot demote newer pending root or borrow name", async () => {
    configure();
    const old = await pendingRoot();
    await stop();
    const freshGate = deferred<void>(), realConnect = realMeshConnect;
    vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(async function (this: InstanceType<typeof MeshNode>) { await freshGate.promise; return realConnect.call(this); });
    const fresh = run();
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(diag.lastRootOutcome()?.result).toBe("pending");
    old.gate.reject(new Error("old"));
    await old.p;
    expect(diag.lastRootOutcome()?.result).toBe("pending");
    expect((await events()).filter(e => e.event === "root_end").at(-1)?.name).toBeUndefined();
    freshGate.resolve();
    await fresh;
    expect(diag.lastRootOutcome()?.reason).toBe("connected");
});
async function pendingRelayRoot(ctx = makeMockCtx()) {
    const gate = deferred<void>();
    connectImpl = async () => { await gate.promise; };
    const p = run("", ctx);
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    return { gate, p, ctx };
}
test("D33 still-connecting reports the relay stage while relay connect is pending", async () => {
    configure();
    const old = await pendingRelayRoot();
    const ctx = makeMockCtx();
    const began = performance.now();
    await run("", ctx);
    const elapsed = performance.now() - began;
    expect(elapsed).toBeLessThan(1000);
    expect(text(ctx)).toContain("Still connecting…");
    expect(text(ctx)).toContain("connecting_relay");
    expect(text(ctx)).not.toContain("joining_mesh");
    expect(messages(ctx, "warning")).toHaveLength(1);
    old.gate.resolve();
    await old.p;
});
test("D34 real failed rename quarantines the unregistered node and a later join republishes", async () => {
    configure(false);
    await incumbent();
    await run();
    expect(await status()).toContain('connected as "agent#2"');
    // Inject the failure BELOW the real rename: `SessionPeer.rename` really tears
    // the connection down and adopts the requested name, THEN `_joinOrLead`
    // rejects. `node.name()` is therefore the unregistered requested name.
    const { SessionPeer } = await import("./session/peer.js");
    const proto = SessionPeer.prototype as unknown as { _joinOrLead: () => Promise<string> };
    const spy = vi.spyOn(proto, "_joinOrLead").mockRejectedValueOnce(new Error("election/registration failed"));
    await run("rename never-published-real");
    spy.mockRestore();
    const s = await status();
    expect(s).not.toContain("never-published-real");
    expect(s).not.toContain("connected as");
    expect(ext._hasMeshNodeForTest()).toBe(false);
    // The failed node is not a surviving registration: a later join really
    // republishes instead of reusing the closed pointer.
    await run();
    expect(ext._hasMeshNodeForTest()).toBe(true);
    expect(await status()).toContain('connected as "agent#2"');
});
test("D35 successful rename adopts reassignment and the active relay room", async () => {
    configure();
    await incumbent();
    await run();
    expect(await status()).toContain('connected as "agent#2"');
    const firstRoom = (instances[0]!.connect.mock.calls[0]![0] as { roomId: string }).roomId;
    expect(await status()).toContain(firstRoom);
    const { SessionPeer } = await import("./session/peer.js");
    const proto = SessionPeer.prototype as unknown as { _joinOrLead: () => Promise<string>; assignedName: string };
    const spy = vi.spyOn(proto, "_joinOrLead").mockImplementationOnce(async function (this: { assignedName: string }) {
        this.assignedName = "renamed#2";
        return "renamed#2";
    });
    await run("rename renamed");
    spy.mockRestore();
    expect(ext._hasMeshNodeForTest()).toBe(true);
    const s = await status();
    expect(s).toContain('connected as "renamed#2"');
    expect(s).toContain('running as "renamed#2"');
    expect(instances.length).toBeGreaterThanOrEqual(2);
    const secondRoom = (instances.at(-1)!.connect.mock.calls[0]![0] as { roomId: string }).roomId;
    expect(secondRoom).not.toBe(firstRoom);
    expect(s).toContain(secondRoom);
});
test("D36 post-assignment publication failure unpublishes the owned node; next root rejoins", async () => {
    configure(false);
    await incumbent();
    // Failure at the SDK name-assigned publication, AFTER `_meshNode = peer`.
    ext._setPiForTest({ sendMessage: () => { throw new Error("publication boom"); } } as unknown as ExtensionAPI);
    const first = makeMockCtx();
    await run("", first);
    // The successful-identity warning must not have been emitted before the
    // remaining publication work succeeded.
    expect(text(first)).not.toContain("This session joined as");
    const s = await status();
    expect(s).not.toContain("connected as");
    expect(s).not.toContain('running as "agent#2"');
    expect(ext._hasMeshNodeForTest()).toBe(false);
    const end = (await events()).at(-1)!;
    expect(end).toMatchObject({ event: "root_end", result: "failed", reason: "join_not_published" });
    expect(end.detail).toContain("publication boom");
    expect(end.detail).not.toContain("lifecycle_superseded");
    // A subsequent root really rejoins instead of reusing the closed pointer.
    ext._setPiForTest({ sendMessage: () => { } } as unknown as ExtensionAPI);
    await run("", makeMockCtx());
    expect(ext._hasMeshNodeForTest()).toBe(true);
    expect(await status()).toContain('connected as "agent#2"');
});
test("D37 rename to the current name is a non-destructive no-op", async () => {
    configure(false);
    await incumbent();
    let node!: InstanceType<typeof MeshNode>;
    const connect = vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(async function (this: InstanceType<typeof MeshNode>) { node = this; return realMeshConnect.call(this); });
    await run();
    expect(node.name()).toBe("agent#2");
    // A same-name rename must not reach the destructive `SessionPeer.rename`
    // (which tears the connection down before it awaits re-registration).
    const { SessionPeer } = await import("./session/peer.js");
    const proto = SessionPeer.prototype as unknown as { _joinOrLead: () => Promise<string> };
    const join = vi.spyOn(proto, "_joinOrLead");
    const ctx = makeMockCtx();
    await run("rename agent#2", ctx);
    expect(join).not.toHaveBeenCalled();
    const p = node.peer() as unknown as { socket: unknown; broker: unknown };
    expect(p.socket).not.toBeNull();
    expect(await status()).toContain('connected as "agent#2"');
    // The live registration is reused — no extra connect.
    await run();
    expect(connect).toHaveBeenCalledTimes(1);
});
test("D38 failed rename cannot keep a registration that a same-looking name string hides", async () => {
    configure(false);
    await incumbent();
    let node!: InstanceType<typeof MeshNode>;
    const connect = vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(async function (this: InstanceType<typeof MeshNode>) { node = this; return realMeshConnect.call(this); });
    await run();
    expect(node.name()).toBe("agent#2");
    // Inject the failure BELOW the real rename (real teardown + name mutation),
    // then force `name()` to keep reporting the OLD name so the defeated
    // `node.name() !== previousName` guard would see "unchanged" and skip
    // quarantine. This is exactly F1's "name equality is not proof" trap.
    const { SessionPeer } = await import("./session/peer.js");
    const proto = SessionPeer.prototype as unknown as { _joinOrLead: () => Promise<string> };
    const join = vi.spyOn(proto, "_joinOrLead").mockRejectedValueOnce(new Error("election/registration failed"));
    const nameSpy = vi.spyOn(MeshNode.prototype, "name").mockReturnValue("agent#2");
    // `_renameAgent` reports through the headless control UI (stderr, warnings
    // and errors only); capture it to prove the failure is reported honestly.
    const stderr: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
    await run("rename changed-but-unregistered");
    writeSpy.mockRestore();
    join.mockRestore();
    const s = await status();
    expect(s).not.toContain("changed-but-unregistered");
    expect(s).not.toContain("connected as");
    expect(s).not.toContain('running as "agent#2"');
    expect(ext._hasMeshNodeForTest()).toBe(false);
    expect(stderr.join("")).toContain("rename failed");
    expect(stderr.join("")).toContain("/remote-pi to reconnect");
    // The next root really joins (a second real connect) instead of reusing a
    // torn-down pointer.
    nameSpy.mockRestore();
    await run();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await status()).toContain('connected as "agent#2"');
});
test("D39 failed rename advertises nothing while real cleanup is still pending", async () => {
    configure(false);
    await incumbent();
    let node!: InstanceType<typeof MeshNode>;
    const connect = vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(async function (this: InstanceType<typeof MeshNode>) { node = this; return realMeshConnect.call(this); });
    await run();
    const { SessionPeer } = await import("./session/peer.js");
    const proto = SessionPeer.prototype as unknown as { _joinOrLead: () => Promise<string> };
    vi.spyOn(proto, "_joinOrLead").mockRejectedValueOnce(new Error("registration failed"));
    // Real teardown is done (`closed === true`); only `SessionPeer.leave`
    // completion is gated, so cleanup is genuinely still pending.
    const gate = deferred<void>();
    const peer = node.peer();
    const realLeave = peer.leave.bind(peer);
    let leaveStarted = false;
    vi.spyOn(peer, "leave").mockImplementation(async () => { leaveStarted = true; await realLeave(); await gate.promise; });
    const rename = run("rename changed-but-unregistered");
    await vi.waitFor(() => expect(leaveStarted).toBe(true));
    expect((node as unknown as { closed: boolean }).closed).toBe(true);
    const s = await status();
    expect(s).not.toContain("connected as");
    expect(s).not.toContain('running as "changed-but-unregistered"');
    expect(s).not.toContain('running as "agent#2"');
    await run();
    expect(connect).toHaveBeenCalledTimes(2);
    gate.resolve();
    await rename;
});
test("D40 real broker reassignment on successful rename reports the active room", async () => {
    configure();
    await incumbent();
    // A real sibling mesh node already owns the requested name, so the broker
    // reassigns a real `#N` (no stub).
    const cfg = await import("./session/global_config.js");
    cfg.ensureGlobalDirs();
    const sockPath = cfg.sessionSockPath(cfg.LOCAL_SESSION_NAME);
    mkdirSync(dirname(sockPath), { recursive: true });
    const other = new MeshNode({ sockPath, name: "occupied-rename", cwd: realpathSync(testCwd) });
    await other.connect();
    try {
        await run();
        await run("rename occupied-rename");
        const s = await status();
        const room = (instances.at(-1)!.connect.mock.calls[0]![0] as { roomId: string }).roomId;
        const peers = await other.listPeers();
        expect(s).toContain('connected as "occupied-rename#2"');
        expect(s).toContain('running as "occupied-rename#2"');
        expect(s).toContain(room);
        expect(peers.some(p => p.endsWith("@occupied-rename#2"))).toBe(true);
    }
    finally {
        await stop();
        await other.close();
    }
});
/**
 * plan/70 B1/G1 shape: keep the REAL rename + teardown, gate the real
 * `_joinOrLead` (so `_joinOrLead` is entered only after the connection was
 * really torn down), then issue `stop` while the rename is in flight. Because
 * `_renameAgent` already cleared `_meshNode` synchronously, `stop` sees an empty
 * slot and cannot clear anything — only the captured publication authority can
 * revoke the attempt.
 */
async function stopDuringRealRename(auto: boolean) {
    configure(auto);
    await incumbent();
    let node!: InstanceType<typeof MeshNode>;
    const connect = vi.spyOn(MeshNode.prototype, "connect").mockImplementationOnce(async function (this: InstanceType<typeof MeshNode>) { node = this; return realMeshConnect.call(this); });
    await run();
    const peer = node.peer() as unknown as { _joinOrLead: () => Promise<string> };
    const real = peer._joinOrLead.bind(peer);
    const gate = deferred<void>();
    let entered = false;
    vi.spyOn(peer, "_joinOrLead").mockImplementationOnce(async () => { entered = true; await gate.promise; return real(); });
    const rename = run("rename stopped-name");
    await vi.waitFor(() => expect(entered).toBe(true));
    const stopCtx = makeMockCtx();
    await run("stop", stopCtx);
    const afterStop = await status();
    const relaysAtStop = instances.length;
    gate.resolve();
    await rename;
    const afterCompletion = await status();
    return { node, connect, stopCtx, afterStop, afterCompletion, relaysAtStop };
}
test("D41 stop during an in-flight mesh-only rename revokes its publication authority", async () => {
    const { node, connect, stopCtx, afterStop, afterCompletion } = await stopDuringRealRename(false);
    // The slot is empty while gated, so stop literally answers "Already stopped";
    // the completion must still refuse to re-publish (an empty slot is not proof
    // of retained ownership).
    expect(text(stopCtx)).toContain("Already stopped");
    expect(afterStop).toContain("not connected");
    expect(afterCompletion).not.toContain("connected as");
    expect(afterCompletion).not.toContain('connected as "stopped-name"');
    expect(afterCompletion).not.toContain('running as "stopped-name"');
    expect(ext._hasMeshNodeForTest()).toBe(false);
    // The orphaned (successfully re-registered) node was torn down by this
    // invocation, so no live identity claim survives.
    expect((node as unknown as { closed: boolean }).closed).toBe(true);
    // A later explicit /remote-pi really joins (a fresh real connect).
    await run();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await status()).toContain('connected as "agent#2"');
});
test("D42 stop during an in-flight relay-enabled rename does not restart the relay", async () => {
    const { node, connect, afterCompletion, relaysAtStop } = await stopDuringRealRename(true);
    expect(afterCompletion).not.toContain('connected as "stopped-name"');
    expect(afterCompletion).not.toContain('running as "stopped-name"');
    expect(afterCompletion).not.toContain("Relay: on");
    expect(ext._hasMeshNodeForTest()).toBe(false);
    expect((node as unknown as { closed: boolean }).closed).toBe(true);
    // No relay re-connect was attempted after stop revoked the attempt.
    expect(instances.length).toBe(relaysAtStop);
    await run();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await status()).toContain('connected as "agent#2"');
});
