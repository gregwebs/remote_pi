import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { generateEd25519Keypair } from "../pairing/crypto.js";
import { ConnectTimeoutError, settle } from "../session/root_deadlines.js";
let ws: MockWS;
class MockWS extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    terminated = false;
    constructor() { super(); ws = this; }
    send(data: string) { this.sent.push(data); }
    open() { this.readyState = 1; this.emit("open"); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.terminated = true; this.close(); }
}
vi.mock("ws", () => ({ default: MockWS }));
const { RelayClient, RoomAlreadyOpenError } = await import("./relay_client.js");
let client: InstanceType<typeof RelayClient>;
beforeEach(() => { vi.useFakeTimers(); client = new RelayClient("ws://test", generateEd25519Keypair()); });
afterEach(() => { client.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
function challenge() { ws.emit("message", JSON.stringify({ type: "challenge", nonce: Buffer.alloc(32).toString("base64") })); }
it("no open hits default deadline and terminates", async () => { const p = settle(client.connect()); await vi.advanceTimersByTimeAsync(20000); expect(await p).toMatchObject({ state: "rejected", error: new ConnectTimeoutError(20000) }); expect(ws.terminated).toBe(true); expect(client.isOpen()).toBe(false); expect(vi.getTimerCount()).toBe(0); });
it("authenticated success clears deadline and preserves forwarding/liveness", async () => { const seen = vi.fn(); client.on("message", seen); const p = client.connect(); ws.open(); challenge(); await p; expect(ws.sent.map(s => JSON.parse(s).type)).toEqual(["hello", "auth"]); expect(seen).not.toHaveBeenCalled(); ws.emit("message", "later"); expect(seen).toHaveBeenCalledWith("later"); expect(vi.getTimerCount()).toBe(1); for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(25000);
    ws.emit("ping");
} expect(client.isOpen()).toBe(true); });
it("late open after timeout cannot authenticate or forward", async () => { const seen = vi.fn(); client.on("message", seen); const p = settle(client.connect({ timeoutMs: 50 })); await vi.advanceTimersByTimeAsync(50); await p; ws.open(); challenge(); await Promise.resolve(); expect(ws.sent).toEqual([]); expect(seen).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); });
it("per-connect override has typed reason", async () => { const p = settle(client.connect({ timeoutMs: 50 })); await vi.advanceTimersByTimeAsync(50); expect(await p).toMatchObject({ state: "rejected", error: { reason: "relay_timeout", timeoutMs: 50 } }); });
it("auth timeout cleans listeners and late challenge cannot send", async () => { const p = settle(client.connect({ timeoutMs: 50 })); ws.open(); expect(ws.listenerCount("message")).toBe(1); await vi.advanceTimersByTimeAsync(50); await p; expect(ws.listenerCount("message")).toBe(0); expect(ws.listenerCount("error")).toBe(1); challenge(); await Promise.resolve(); expect(ws.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(0); });
it("error before open preserves identity and fences late open", async () => { const error = new Error("refused"); const p = settle(client.connect()); ws.emit("error", error); expect(await p).toEqual({ state: "rejected", error }); ws.open(); expect(ws.sent).toEqual([]); expect(ws.terminated).toBe(true); });
it("room collision preserves typed auth error and cleans up", async () => { const p = settle(client.connect({ roomId: "room" })); ws.open(); ws.emit("message", JSON.stringify({ type: "error", code: "room_already_open" })); const result = await p; expect(result).toMatchObject({ state: "rejected", error: new RoomAlreadyOpenError("room") }); expect(ws.listenerCount("message")).toBe(0); expect(ws.terminated).toBe(true); });
it("explicit close cancels open and auth phases and is repeatable", async () => { for (const open of [false, true]) {
    const p = settle(client.connect());
    if (open)
        ws.open();
    client.close();
    client.close();
    expect(await p).toMatchObject({ state: "rejected" });
    ws.open();
    challenge();
    await Promise.resolve();
    expect(ws.sent).toHaveLength(open ? 1 : 0);
    expect(client.isOpen()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
} });
it("a superseded authenticated socket's late close cannot clear the newer owner", async () => {
    const p1 = client.connect({ timeoutMs: 5000 });
    const first = ws;
    first.open();
    challenge();
    await p1;
    expect(client.isOpen()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    const p2 = client.connect({ timeoutMs: 5000 });
    const second = ws;
    expect(second).not.toBe(first);
    second.open();
    challenge();
    await p2;
    expect(client.isOpen()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    // The superseded socket's late lifecycle must not stop the newer owner's
    // liveness watchdog or null its connection.
    first.close();
    first.emit("error", new Error("old refused late"));
    expect(client.isOpen()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    const seen = vi.fn();
    client.on("message", seen);
    second.emit("message", "newer still routed");
    expect(seen).toHaveBeenCalledWith("newer still routed");
});
