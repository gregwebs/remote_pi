import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * plan/70 Wave 0: make silent root exits observable without changing control flow.
 * Append-only ~/.pi/remote/logs/remote-pi.log has one JSON line per event.
 * The in-memory outcome feeds /remote-pi status, not historical file reads.
 * Memory updates immediately; ordered writes yield before serialization/I/O.
 * Path/schema match daemon/cron_log.ts, but persistence is deferred and
 * best-effort: abrupt process exit may lose buffered records. Diagnostics
 * never break a root, including when invoked from its finally block.
 */
/** Why the session_start auto-init did not start the root (plan/70 0.1). */
export type AutoInitSkipReason =
  | "no_cwd" | "print_mode" | "already_inited" | "no_local_config" | "auto_start_relay_false";

/** Final classification of one `_cmdRoot` run (see classifyRootEnd). */
export type RootEndReason =
  | "disposed" | "relay_timeout" | "exception" | "lifecycle_superseded" | "lock_refused" | "no_local_config"
  | "join_not_published" | "relay_not_started" | "connected" | "relay_disabled";

export interface StepOutcome {
  result: "ok" | "failed" | "stale";
  reason: string;
  detail?: string;
}

export type StepResult = "ok" | "failed" | "stale" | "refused";

export type LifecycleEventName =
  | "session_start_autoinit" | "command"
  | "root_wait_begin" | "root_wait_end" | "root_begin" | "root_end"
  | "lock_fallback" | "relay_start_begin" | "relay_start_end" | "join_attempt_begin" | "join_attempt_end"
  | "lock_result" | "join_begin" | "join_end" | "relay_connect_begin" | "relay_connect_end";

/** What callers pass. `ts` + `pid` are stamped by recordLifecycle. */
export interface LifecycleEventInput {
  event: LifecycleEventName;
  outcomeId?: number;
  decision?: "start" | "skip";
  result?: StepResult;
  reason?: string;          // AutoInitSkipReason | RootEndReason | "alias_of_root" | … (free-form on purpose: Wave B adds more)
  detail?: string;          // already-stringified (use errorText for errors)
  verb?: string;
  generation?: number;      // root lifecycle generation
  restart?: boolean;        // root_begin via RootRestartAuthority (re-arm path)
  cwd?: string;
  lockPath?: string;        // real JSON field on lock_result (success and refusal); not detail
  name?: string;
  room?: string;
}

/** One line of ~/.pi/remote/logs/remote-pi.log. */
export interface LifecycleEvent extends LifecycleEventInput {
  ts: string;               // ISO-8601
  pid: number;
}

export type RootOutcomeResult = "ok" | "failed" | "stale" | "skipped" | "pending";

/** In-memory "last start" shown by `/remote-pi status` (spec's `_rootOutcome`). */
export interface RootOutcome {
  at: number;               // epoch ms (root_begin for pending; end/skip time otherwise)
  result: RootOutcomeResult;
  reason: string;
  detail?: string;
}

/** Observable state right after `_cmdRootInner` settles. Built by index.ts. */
export interface RootEndSnapshot {
  error?: { value: unknown };   // present iff the run rejected
  disposed?: boolean;
  configDetail?: string;
  join?: StepOutcome;
  relay?: StepOutcome;
  lifecycleCurrent: boolean;
  lockHeld: boolean;
  configExists: boolean;
  autoStartRelay: boolean;
  meshJoined: boolean;
  relayStarted: boolean;
}

let _pathOverride: string | null = null;
let _outcome: RootOutcome | null = null;
let _selectedOutcomeId = 0;
let _nextOutcomeId = 0;
export function allocateOutcomeId(): number { return ++_nextOutcomeId; }

export function lifecycleLogPath(): string {
  return _pathOverride ?? join(process.env["REMOTE_PI_HOME"] || homedir(), ".pi", "remote", "logs", "remote-pi.log");
}

async function appendLines(path: string, lines: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, lines, "utf8");
  } catch { /* best-effort; a failed destination must not stop later batches */ }
}

export async function appendLifecycleLog(event: LifecycleEvent, path?: string): Promise<void> {
  try { await appendLines(path ?? lifecycleLogPath(), JSON.stringify(event) + "\n"); }
  catch { /* includes serialization and path-resolution failures */ }
}

const _queue: Array<{ input: LifecycleEventInput; now: number; pid: number; path: string }> = [];
let _writer: Promise<void> | null = null;

/** One deferred FIFO writer; only consecutive same-path events are batched. */
function _scheduleWriter(): void {
  if (_writer) return;
  let finish!: () => void;
  _writer = new Promise<void>(resolve => { finish = resolve; });
  try {
    setImmediate(() => {
      void (async () => {
        try {
          while (_queue.length) {
            const path = _queue[0]!.path;
            let lines = "";
            while (_queue[0]?.path === path) {
              const item = _queue.shift()!;
              try { lines += JSON.stringify({ ...item.input, ts: new Date(item.now).toISOString(), pid: item.pid }) + "\n"; }
              catch { /* discard only the unserializable event */ }
            }
            if (lines) await appendLines(path, lines);
          }
        } catch { /* no unhandled rejection from diagnostics */ }
        finally { _writer = null; finish(); }
      })();
    });
  } catch { _queue.length = 0; _writer = null; finish(); }
}

export function recordLifecycle(input: LifecycleEventInput, now: number = Date.now()): void {
  try {
    _applyToOutcome(input, now);
    // Capture destination and data now; later override/env/reset cannot reroute it.
    _queue.push({ input: { ...input }, now, pid: process.pid, path: lifecycleLogPath() });
    _scheduleWriter();
  } catch { /* called from finally blocks: never replace a root rejection */ }
}

/** Test-only: wait for scheduled/in-progress batches, including later arrivals. */
export async function _flushLifecycleLogForTest(): Promise<void> {
  while (_writer || _queue.length) {
    if (!_writer) _scheduleWriter();
    await _writer;
  }
}

export function lastRootOutcome(): RootOutcome | null { return _outcome; }

export function classifyRootEnd(s: RootEndSnapshot): { result: "ok" | "failed" | "stale"; reason: RootEndReason; detail?: string } {
  if (s.error) return { result: "failed", reason: "exception", detail: errorText(s.error.value) };
  if (!s.lifecycleCurrent || s.disposed) return { result: "stale", reason: s.disposed ? "disposed" : "lifecycle_superseded" };
  if (!s.lockHeld) return { result: "failed", reason: "lock_refused" };
  if (!s.configExists) return { result: "failed", reason: "no_local_config", ...(s.configDetail ? { detail: s.configDetail } : {}) };
  if (s.join && s.join.result !== "ok") return { result: "failed", reason: "join_not_published", detail: childDetail(s.join) };
  if (!s.meshJoined) return { result: "failed", reason: "join_not_published" };
  if (s.relay && s.relay.result !== "ok") return { result: "failed", reason: s.relay.reason === "relay_timeout" ? "relay_timeout" : "relay_not_started", detail: childDetail(s.relay) };
  if (s.relayStarted) return { result: "ok", reason: "connected" };
  if (s.autoStartRelay) return { result: "failed", reason: "relay_not_started" };
  return { result: "ok", reason: "relay_disabled" };
}

export function formatRootOutcomeLine(o: RootOutcome, now: number, logPath: string = lifecycleLogPath()): string {
  const seconds = Math.max(0, Math.floor((now - o.at) / 1000));
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  const display = displayPath(logPath);
  if (o.result === "pending") return `⚠️ Last start: still running — ${o.reason} (for ${age}) · log: ${display}`;
  return `⚠️ Last start: ${o.result} — ${o.reason}${o.detail ? `: ${trunc(o.detail, 80)}` : ""} (${age} ago) · log: ${display}`;
}

export function errorText(err: unknown): string {
  try { return trunc(err instanceof Error ? err.message || err.name : String(err), 300); }
  catch { return "<unprintable error>"; }
}

/** Test-only. null restores the default path. */
export function _setLifecycleLogPathForTest(path: string | null): void { _pathOverride = path; }
/** Test-only: clears memory, not the path override. */
export function _resetRootDiagnosticsForTest(): void { _outcome = null; _selectedOutcomeId = 0; }

function _applyToOutcome(e: LifecycleEventInput, now: number): void {
  const begins = e.event === "root_begin" || e.event === "relay_start_begin" || e.event === "join_attempt_begin";
  const ends = e.event === "root_end" || e.event === "relay_start_end" || e.event === "join_attempt_end";
  const stage = e.event === "join_begin" || e.event === "relay_connect_begin";
  if (e.outcomeId !== undefined && (begins || ends || stage)) {
    if (e.outcomeId < _selectedOutcomeId || (stage && e.outcomeId !== _selectedOutcomeId)) return;
    _selectedOutcomeId = e.outcomeId;
  }
  switch (e.event) {
    case "session_start_autoinit":
      if (e.decision === "skip" && e.reason !== "already_inited") {
        _outcome = { at: now, result: "skipped", reason: e.reason ?? "unknown", ...(e.detail ? { detail: e.detail } : {}) };
      }
      return;
    case "relay_start_begin":
    case "join_attempt_begin":
    case "root_begin":
      _outcome = { at: now, result: "pending", reason: e.event === "root_begin" ? "root_in_progress" : e.event === "join_attempt_begin" ? "joining_mesh" : "connecting_relay" };
      return;
    case "join_begin":
    case "relay_connect_begin":
      if (_outcome?.result === "pending") {
        _outcome = { ..._outcome, reason: e.event === "join_begin" ? "joining_mesh" : "connecting_relay" };
      }
      return;
    case "relay_start_end":
    case "join_attempt_end":
    case "root_end":
      _outcome = {
        at: now,
        result: e.result === "ok" || e.result === "stale" ? e.result : "failed",
        reason: e.reason ?? "unknown",
        ...(e.detail ? { detail: e.detail } : {}),
      };
      return;
    default:
      return; // command, lock_result, *_end, root_wait_* never change the outcome
  }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function childDetail(outcome: StepOutcome): string { return outcome.reason + (outcome.detail ? `: ${outcome.detail}` : ""); }
export function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}
export interface LockFallback {
  requested: string;
  effective: string;
  ownerLockPath: string;
  room?: string;
}
export function formatLockFallbackLine(f: LockFallback): string {
  return `Identity: running as "${f.effective}"${f.room ? ` (identity room ${f.room})` : ""} — "${f.requested}" held by another live Pi (lock: ${displayPath(f.ownerLockPath)}) · reason: lock_suffixed`;
}
/** Same room algorithm as rooms.ts, using an already-canonicalized snapshot. */
export function identityRoom(canonicalTarget: string, defaultName: string, assigned: string): string {
  return createHash("sha256").update(canonicalTarget + (assigned === defaultName ? "" : "\0" + assigned)).digest("base64url").slice(0, 12);
}
