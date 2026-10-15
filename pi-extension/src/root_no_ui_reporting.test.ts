/**
 * Regression for verification finding F-A (plan/70 Waves B/C).
 *
 * `pi -p "/remote-pi"` in a folder with no `.pi/` config used to be completely
 * mute: the SDK's print-mode UI installs `noOpUIContext`, whose `select` is a
 * *defined* stub (`async () => undefined`) and whose `notify` is `() => {}`.
 * The old "no interactive UI" probe (`typeof ui.select !== "function"`) could
 * therefore not see it, so the command took the `setup_cancelled` wizard path
 * and every notify/status line was discarded — stdout and stderr both empty.
 *
 * The fix keys the probe off `ctx.hasUI === false` (true for `noOpUIContext`)
 * and, when there is no real UI, writes the actionable line to stderr — the
 * channel `_headlessUi()` already uses — while leaving the interactive/RPC
 * `notify` path byte-for-byte unchanged.
 *
 * These tests drive the real `/remote-pi` command handler over the real
 * extension module (no relay/mesh connection is attempted: the no-config branch
 * returns before any join).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleEvent } from "./session/root_diagnostics.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "rp-noui-"));
process.env["REMOTE_PI_HOME"] = home;

const diag = await import("./session/root_diagnostics.js");
diag._setLifecycleLogPathForTest(join(home, "lifetime.log"));
const ext = await import("./index.js");

/** The SDK's print-mode no-op UI, faithfully shaped. */
function printModeCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      // defined stubs — this is why `typeof select === "function"` is a lie.
      select: vi.fn(async (_title: string, _options: string[]) => undefined),
      input: async (_title: string, _options?: { defaultValue?: string }) => undefined,
    },
  };
}

/** An interactive/RPC ctx: real UI flag + a real (cancelling) picker. */
function interactiveCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: vi.fn(),
      select: vi.fn(async (_title: string, _options: string[]) => undefined),
    },
  };
}

/** The internal headless ctx shape (`_headlessUi()`): notify only, no hasUI. */
function headlessCtx(cwd: string) {
  return {
    cwd,
    ui: { notify: vi.fn() },
  };
}

type Ctx = ReturnType<typeof printModeCtx> | ReturnType<typeof interactiveCtx> | ReturnType<typeof headlessCtx>;
type Handler = (args: string, ctx: Ctx) => Promise<void>;

let handlers: Map<string, Handler>;
let logPath: string;
let sequence = 0;
let stderrChunks: string[];

function notifyText(ctx: Ctx): string {
  return (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("\n");
}
function notifyLevel(ctx: Ctx, level: string): string[] {
  return (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1] === level).map((c) => String(c[0]));
}
function stderrText(): string {
  return stderrChunks.join("");
}
function events(): LifecycleEvent[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LifecycleEvent);
}
function rootEnd(): LifecycleEvent | undefined {
  return events().filter((e) => e.event === "root_end").at(-1);
}
function register(): void {
  handlers = new Map();
  ext.default({
    on: () => undefined,
    registerCommand: (name: string, opts: { handler: Handler }) => handlers.set(name, opts.handler),
    registerTool() { }, registerShortcut() { }, registerFlag() { }, getFlag() { },
    registerMessageRenderer() { }, sendMessage() { }, sendUserMessage() { },
  } as unknown as ExtensionAPI);
}
async function run(args: string, ctx: Ctx): Promise<void> {
  const handler = handlers.get("remote-pi");
  if (!handler) throw new Error("remote-pi handler not registered");
  await handler(args, ctx);
  await diag._flushLifecycleLogForTest();
}

beforeEach(async () => {
  await diag._flushLifecycleLogForTest();
  logPath = join(home, `no-ui-${++sequence}.log`);
  diag._setLifecycleLogPathForTest(logPath);
  diag._resetRootDiagnosticsForTest();
  ext._setDisposedForTest(false);
  ext._resetAutoInitedForTest();
  stderrChunks = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { stderrChunks.push(String(chunk)); return true; });
  register();
});

afterEach(async () => {
  ext._resetCwdLockForTest();
  ext._setDisposedForTest(false);
  ext._resetAutoInitedForTest();
  diag._resetRootDiagnosticsForTest();
  await diag._flushLifecycleLogForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("print mode with no config reports no_local_config on stderr and is not mute", async () => {
  const cwd = mkdtempSync(join(home, "cwd-"));
  const ctx = printModeCtx(cwd);

  await run("", ctx);

  // The surviving channel carries the actionable line.
  const err = stderrText();
  expect(err).toContain("no_local_config");
  expect(err).toContain("[remote-pi]");
  expect(err).toContain("interactive");
  // Exactly one line — no duplicate emission.
  expect(err.trim().split("\n")).toHaveLength(1);

  // Terminal outcome recorded honestly, NOT as a cancelled wizard.
  const end = rootEnd();
  expect(end).toMatchObject({ event: "root_end", result: "failed", reason: "no_local_config", detail: "no_interactive_ui" });
  expect(events().some((e) => e.detail === "setup_cancelled")).toBe(false);

  // The wizard is never entered (the picker stub was not consumed).
  expect(ctx.ui.select).not.toHaveBeenCalled();
  // The dropped notify path still produced status + warning; stderr is what
  // actually survives in print mode.
  expect(notifyText(ctx)).not.toContain("Setup cancelled.");
  expect(notifyText(ctx)).toContain("Local mesh");
  expect(notifyLevel(ctx, "warning").join("\n")).toContain("no_local_config");
});

test("interactive/RPC ctx keeps the wizard flow, its status, and emits no stderr line", async () => {
  const cwd = mkdtempSync(join(home, "cwd-"));
  const ctx = interactiveCtx(cwd);

  await run("", ctx);

  // Real picker was used (wizard flow intact), and it cancelled.
  expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  expect(notifyText(ctx)).toContain("Setup cancelled.");
  expect(notifyText(ctx)).toContain("Local mesh");
  // No duplicate channel: interactive sessions get no stderr line.
  expect(stderrText()).toBe("");
  // No spurious warning in the normal cancel path.
  expect(notifyLevel(ctx, "warning")).toHaveLength(0);

  // Terminal outcome is the cancelled wizard, not no_interactive_ui.
  expect(rootEnd()).toMatchObject({ event: "root_end", result: "failed", reason: "no_local_config", detail: "setup_cancelled" });
});

test("internal headless ctx (no hasUI, no select) keeps its existing notify-only behaviour", async () => {
  const cwd = mkdtempSync(join(home, "cwd-"));
  const ctx = headlessCtx(cwd);

  await run("", ctx);

  // Same terminal classification as before this fix.
  expect(rootEnd()).toMatchObject({ event: "root_end", result: "failed", reason: "no_local_config", detail: "no_interactive_ui" });
  // The new direct-stderr write is gated on the SDK no-op UI, so the internal
  // headless ctx is unchanged: the warning stays on its own notify channel
  // (in production `_headlessUi()` forwards it to stderr).
  expect(stderrText()).toBe("");
  expect(notifyLevel(ctx, "warning").join("\n")).toContain("no_local_config");
});
