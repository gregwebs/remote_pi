import { afterEach, expect, it } from "vitest";
import { createServer, type Server, type AddressInfo } from "node:net";
import { generateEd25519Keypair } from "../pairing/crypto.js";
import { ConnectTimeoutError, settle } from "../session/root_deadlines.js";
import { RelayClient } from "./relay_client.js";

/**
 * Verifier-added integration coverage for the plan/70 C2 relay half.
 *
 * The planned transport regression (`relay_connect_timeout.test.ts`) drives
 * `RelayClient` with a MOCKED `ws` module, so it proves the deadline logic but
 * not that a real WebSocket handshake against a real socket is actually
 * aborted. These two tests use the real `ws` client against real TCP servers:
 * one that accepts the connection and never completes the upgrade (deadline
 * must fire and terminate), and one that refuses immediately (a fast failure,
 * not a deadline). Both were observed end-to-end in a live `pi --mode rpc`
 * session before being encoded here.
 */

const servers: Server[] = [];
const sockets: import("node:net").Socket[] = [];
const clients: RelayClient[] = [];

function hangServer(): Promise<{ port: number; server: Server }> {
    return new Promise((resolve, reject) => {
        // Accept TCP connections and never write a byte: the WS upgrade hangs.
        const server = createServer((socket) => { sockets.push(socket); });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            servers.push(server);
            resolve({ port: (server.address() as AddressInfo).port, server });
        });
    });
}

function closeServer(server: Server): Promise<void> {
    const i = servers.indexOf(server);
    if (i >= 0) servers.splice(i, 1);
    // destroy accepted sockets first: server.close() waits for live connections.
    for (const socket of sockets.splice(0)) {
        try { socket.destroy(); } catch { /* best-effort */ }
    }
    return new Promise<void>((resolve) => {
        const done = (): void => resolve();
        server.close(done);
        setTimeout(done, 500).unref?.();
    });
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        try { client.close(); } catch { /* best-effort */ }
    }
    await Promise.all(servers.splice(0).map(closeServer));
});

it("real WS open deadline fires and terminates against a socket that never upgrades", async () => {
    const { port } = await hangServer();
    const client = new RelayClient(`ws://127.0.0.1:${port}`, generateEd25519Keypair());
    clients.push(client);
    const started = Date.now();
    const result = await settle(client.connect({ timeoutMs: 400 }));
    const elapsed = Date.now() - started;
    expect(result.state).toBe("rejected");
    if (result.state === "rejected") {
        expect(result.error).toBeInstanceOf(ConnectTimeoutError);
        expect((result.error as ConnectTimeoutError).reason).toBe("relay_timeout");
    }
    // Fires near the injected deadline, not the 20s default.
    expect(elapsed).toBeLessThan(3000);
    expect(client.isOpen()).toBe(false);
});

it("real connection refused fails fast without waiting for the deadline", async () => {
    const { port, server } = await hangServer();
    await closeServer(server);
    const client = new RelayClient(`ws://127.0.0.1:${port}`, generateEd25519Keypair());
    clients.push(client);
    const started = Date.now();
    const result = await settle(client.connect({ timeoutMs: 5000 }));
    expect(result.state).toBe("rejected");
    if (result.state === "rejected") expect(result.error).not.toBeInstanceOf(ConnectTimeoutError);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(client.isOpen()).toBe(false);
});
