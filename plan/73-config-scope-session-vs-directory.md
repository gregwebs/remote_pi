# 73 — Config scope: session-owned config in `~/.pi` (dropping per-directory)

> **Language note.** The plan corpus (`plan/*.md`) is written in pt-BR. This plan is in
> **English** at the owner's request (2026-10-15). Ask if you want a pt-BR mirror;
> behavioral decisions live here, not in the language.

Status: **decided direction (2026-10-15) — not implemented.** Direction chosen by the owner:
*global-only, scoped to the session (drop per-directory)*. Implementation scheduled **after the
`plan/70` Wave B/C fixes land and 0.7.1 ships**.

## Contexto

### What triggered this (2026-10-15, captured while shipping `plan/70`)

All of these were observed on a real host (`pi` 1.0.0, `pi-extension` 0.7.0, macOS), with the
instrumented build (`pi -ne -e dist/index.js`) writing to `~/.pi/remote/logs/remote-pi.log`:

| Observation | Raw evidence |
|---|---|
| **Two sessions in one folder ≠ zero conflict** | Session 1 (pid 46548) owns the lock. Session 2 logs `lock_result refused lockPath=…/locks/-FQSLDBwKvJt.sock`, then `lock_result ok lockPath=…/locks/fESJvauu7yVp.sock`, and ends `root_end ok reason=connected name="agent-vm#2" room="fESJvauu7yVp"` — a **different identity and room, announced to nobody** |
| **Directory config can't express session intent** | `/Users/claude/code/microsandbox` had no `.pi/` at all; `status` showed `⚪ Relay: off (…) — run /remote-pi to start`, and both `/remote-pi start` and `/remote-pi relay start` were mute (0.7.0: `start` isn't a verb; `relay start` = `_cmdStart`, which cannot configure) |
| **A live session can lose its extension instance entirely** | A 22 h session answered `status` but silently no-oped every state-changing command; `/remote-pi relay start` printed nothing (`isCurrentCandidate()` bail: `!_disposed`). `/reload` fixed it |
| **Repo pollution** | `/Users/claude/code/microsandbox` after the wizard: `?? .pi/` in `git status` |
| **No inheritance for subdirs/worktrees** | A session in a subdirectory or worktree of a configured project finds no config → silent auto-start skip. The fork `pungggi/remote_pi` patched this with a `process.cwd()` fallback, whose comment names the symptom: *"left freshly-spawned worktree pis idle (\"Relay: off\")"*. Our host runs `@harms-haus/pi-worktrees` |

The upstream **#242 / #236** family is adjacent (re-arm of unconfigured session replacements), and
**#203** touches the same `session_start` auto-init region — both will collide with P4/P6 below.

### What is actually wrong (and what is not)

The problem is **not** where the file lives — it is that two different axes are mixed:

1. **`auto_start_relay` is a session intent stored in a directory-scoped file.** One answer for every
   session in that directory. There is no way to express "auto-start my main window here, but not the
   second window".
2. **Identity is directory-derived** (`defaultAgentName(cwd)`), while **pairing is per session**
   (`plan/00-decisions.md`: *"Pareamento = 1 sessão (MVP)"*, QR generated per session). Two sessions
   in one directory therefore ask for the **same** name, and the loser is disambiguated by a runtime
   accident (`#N`) — silently.
3. **No inheritance**: worktrees and subdirectories inherit nothing, and skip in silence.
4. **Repo pollution / shared state**: the file lands untracked in every repo, and in a team repo it
   is shared — an accidental identity that travels with the checkout.

### What already exists — do not rebuild it

- **Rooms are already name-aware.** `roomIdFor(cwd, name)` (`plan/41`, `src/rooms.ts`) returns a
  name-scoped room for a custom name and the exact legacy cwd-room when the name is absent or equals
  `defaultAgentName(cwd)`. So *distinct names in one folder already produce distinct rooms*, and a
  single unnamed agent keeps its existing conversation. **This plan needs no wire/pairing change.**
- **`#N` is already classified as an accident.** `plan/38` + `migrateAgentName()`
  (`src/session/local_config.ts`) strip a trailing `#<digits>` on read precisely because a user
  cannot type `#` (`sanitizeSegment` maps it to `-`).
- **The relay URL is already global**: `~/.pi/remote/config.json`, resolution order
  `env REMOTE_PI_RELAY` > global file > default (`plan/14`).
- **The host exposes session identity to extensions.** `ExtensionContext.sessionManager`
  (`ReadonlySessionManager`) gives `getSessionId()`, `getSessionFile()`, `getSessionName()`,
  `getCwd()` — verified in `pi` 1.0.0
  (`dist/core/session-manager.d.ts:178,246-277`; `dist/core/extensions/types.d.ts:215-223`).
  `SessionStartEvent.reason` ∈ `startup | reload | new | resume | fork` (`types.d.ts:547-553`).
  ⇒ A session can key its own record **without any new host API**. This is the enabler for the
  chosen direction.
- **An escape hatch exists**: `REMOTE_PI_DIRECT_CONFIG` carries a whole config as inline JSON for
  CI/daemons (`src/session/local_config.ts`). Keep and extend it — never remove it.

## Decisão

Configuration becomes **global + session-scoped**:

```
~/.pi/remote/
├── config.json              # GLOBAL defaults (relay URL already lives here)
├── sessions.json            # per-session records, keyed by sessionManager.getSessionId()
├── daemons.json             # (plan/26) registry; gains `name` instead of reading the project file
├── peers.json               # unchanged
└── logs/remote-pi.log       # plan/70 Wave 0, unchanged
```

Per-directory `<cwd>/.pi/remote-pi/config.json` is **deprecated**: still read as the
lowest-precedence fallback (so no existing pairing breaks), reported once as deprecated, and
importable/removable with an explicit command.

### Precedence (first hit wins)

| # | Source | Holds |
|---|---|---|
| 1 | Env (`REMOTE_PI_DIRECT_CONFIG`, `REMOTE_PI_RELAY`) | whole config / relay URL — unchanged escape hatch |
| 2 | Session record (`sessions.json` → `getSessionId()`) | `name`, `auto_start_relay` — the canonical new home |
| 3 | Global defaults (`~/.pi/remote/config.json`) | `relay`, `auto_start_relay` default, `name_template` |
| 4 | Legacy `<cwd>/.pi/remote-pi/config.json` | `agent_name`, `auto_start_relay` — deprecated, warns once |
| 5 | Built-ins | `name_template` = `{basename(cwd)}`, `auto_start_relay` = `true` |

### Name resolution (per session)

1. explicit mesh name in the session record (set by `/remote-pi name <n>`, sanitized via
   `sanitizeSegment`), else
2. pi's own session display name — `sessionManager.getSessionName()` (sanitized), else
3. `name_template` from global config, expanded (`{basename(cwd)}` by default), else
4. legacy `agent_name` (step 4 above), else
5. `defaultAgentName(cwd)`.

### Collision policy — never silent (this is the core UX fix)

If another **live** session already owns `(cwd, name)`:

- Default: continue as an **announced** `<name>-2` (a hyphen, not `#2` — `#` is reserved for the
  broker's runtime suffix and is stripped by `migrateAgentName`), with a one-line warning naming the
  holder's pid and lock path, and the hint `/remote-pi name <n>`.
- Alternative: stay idle and say so (this is the option to choose when `auto_start_relay` came from
  the *global* default rather than an explicit session choice).
- **Never** a silent suffix. (Independent of this plan, `plan/70` B3 lands this for 0.7.1.)

Both sessions then live in **distinct rooms** through the existing `roomIdFor(cwd, name)` — one tile
per agent in the app, no protocol change.

## Estrutura esperada

```
pi-extension/src/
├── session/global_config.ts        # exists: global dirs; gains sessions.json read/write
├── session/session_config.ts       # NEW: session record store (atomic write, merge, prune)
├── session/local_config.ts         # becomes the LEGACY reader (deprecated) + REMOTE_PI_DIRECT_CONFIG
├── session/name_resolution.ts      # NEW: precedence chain + sanitize + collision policy
├── index.ts                        # /remote-pi name <n>, /remote-pi migrate [--clean]; auto-init reads the new resolver
├── extension.test.ts               # two-sessions-same-cwd, precedence, migration, no-repo-writes
└── README.md                       # config scope + migration story
```

`sessions.json` shape (single file, atomic `tmp` + `rename`, read-modify-write under a lock-free
retry; unknown keys preserved):

```json
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "name": "agent-vm",
      "auto_start_relay": true,
      "cwd": "/Users/claude/code/agent-vm",
      "session_file": "…/2026-10-15T09-37-11-155Z_01a13eec-….jsonl",
      "first_seen": "2026-10-15T11:21:57Z",
      "last_seen": "2026-10-15T11:21:57Z"
    }
  }
}
```

Single file (rather than one file per session) keeps GC and reads simple and matches
`peers.json`/`daemons.json`; the cost is contended writes, handled by atomic rename + a
re-read-and-merge on conflict. Records are pruned by `last_seen` (default 90 days, global config).

## Passos

### P1 — global defaults + precedence reader

Extend `~/.pi/remote/config.json` with `auto_start_relay` (default `true`) and
`name_template` (default `{basename(cwd)}`), keeping `relay` as is. One reader implements the
5-step precedence table.
**Aceite**: unit tests for each precedence pair (env over session, session over global, global over
legacy, legacy over built-in); `relay` resolution behavior unchanged (plan/14 matrix still green).

### P2 — session record store

New `session_config.ts`: read/write `sessions.json` keyed by `sessionManager.getSessionId()`, atomic
write, merge-on-conflict, `first_seen`/`last_seen`, pruning. When the host gives no id
(`--no-session`) or `sessionManager` is unavailable, keep the record **in memory** for that process
and never write.
**Aceite**: two concurrent processes writing different session ids both persist (no lost update);
`--no-session` writes nothing; pruning leaves records newer than the window and drops stale ones.

### P3 — name resolution + explicit collision

`name_resolution.ts` implements the chain and the collision policy; new command
`/remote-pi name <n>` writes the session record (sanitized, reserved words rejected, `#` mapped).
**Aceite**: in one cwd, session A resolves `agent-vm`; session B (primary lock held) announces
`agent-vm-2` in one warning naming the holder's pid + lock path, and `root_end` in the log carries
`name` + the distinct `room`; `/remote-pi name backend` makes B `backend` in its own room; empty or
`broadcast`/`broker` names are refused with a message.

### P4 — session-scoped auto-start intent

Auto-init reads `auto_start_relay` from the resolver (env > session record > global > legacy >
default). A session whose record says `false` stays idle, **and says so** (`status` third line:
`skip — auto_start_relay_false`).
**Aceite**: two sessions in one cwd with records `true` and `false` ⇒ exactly one starts the root;
the other logs/report the reason; deleting a record falls back to the global default.

### P5 — legacy read-through, migration, repo hygiene

Legacy files are read as step 4, notify once ("config moved to `~/.pi/remote`; the per-directory file
is deprecated"), and `/remote-pi migrate [--clean]` imports into the session record
(`--clean` deletes `<cwd>/.pi/remote-pi/`).
**Aceite**: an existing `<cwd>/.pi/remote-pi/config.json` (`agent_name: agent-vm`) still produces
name `agent-vm` **and the same room id as before** (pairing survives — assert the room id literally);
after `migrate --clean`, behavior is identical and the repo shows no `.pi/`; a from-scratch session
in a repo never writes anything inside the project directory.

### P6 — daemon path (plan/26) updated

`plan/26-daemon-mode.md:25` currently states the project file is the *single source* ("`Nome`,
`agent_name`, `auto_start_relay` etc. moram em `<cwd>/.pi/remote-pi/config.json`"). A daemon has no
pi session id, so daemon records key on their existing derived id and store `name` in
`daemons.json` (registry already holds `cwd` + id).
**Aceite**: `/remote-pi create ~/foo --name X` writes **no** files inside `~/foo`, and the daemon
still comes up as `X`; plan/26's table is updated to point at the registry.

### P7 — docs and decision records

- `pi-extension/README.md`: config scope, precedence, migration, `/remote-pi name`.
- `plan/00-decisions.md`, per its own rules (strike through + dated reason, never silent edit):
  - **Multi-instância → "2 terminais Pi na mesma pasta … Zero conflito"** is falsified: strike it and
    record "distinct names ⇒ distinct rooms (plan/41); the loser is announced, never silently
    suffixed (plan/70 B3); config/identity move to the session (plan/73)".
  - **New bullet** under Arquitetura: "Config global (`~/.pi/remote/config.json`) + por sessão
    (`sessions.json`, chave = session id); `<cwd>/.pi/remote-pi/config.json` é legado (fechado
    2026-10-15 — plano 73)".
- `plan/19-agent-network.md:103` ("só por cwd"), `plan/21-setup-wizard.md:14-18`,
  `plan/26-daemon-mode.md:25`: add a superseded-by-73 header line, keep the original text for history
  (same convention as `00-decisions.md`).
**Aceite**: no doc still asserts that config/identity is per-directory as the current model; `grep`
for `.pi/remote-pi/config.json` finds it only in the deprecation/migration contexts.

## Definition of Done

- [ ] P1 precedence matrix green, `relay` resolution unchanged
- [ ] P2 `sessions.json` atomic + concurrent-safe; nothing written for ephemeral sessions
- [ ] P3 two sessions in one cwd ⇒ two names, two rooms, one warning, no silent `#N`
- [ ] P4 per-session auto-start intent honored, with a visible reason when skipped
- [ ] P5 legacy config preserves name **and room id** (pairing survives); `migrate --clean` removes it
- [ ] P6 `/remote-pi create` writes nothing inside the project directory
- [ ] P7 README + `00-decisions.md` strike-throughs + plan 19/21/26 supersede notes landed
- [ ] Repo hygiene: after a full session in a configured repo, `git status` is clean of `.pi/`
- [ ] `pnpm typecheck && pnpm test && pnpm build` green (and `prepublishOnly`-clean)

## Em aberto (decidir com uso real, não antes)

| Item | Decide when |
|---|---|
| Default for the losing session: announced `<name>-2` vs stay idle | After B3 ships and real two-session usage is observable (the message makes both acceptable) |
| Precedence between pi's session name (`getSessionName()`) and an explicit mesh name | Proposal above: explicit mesh name wins. Revisit if pi's `/name` becomes the habit |
| Prune window for `sessions.json` (default 90 days) | If the file grows or a stale name keeps reserving an identity |
| Whether daemon records live in `daemons.json` or their own file | With plan/26's next wave |
| Reusing a session name across cwds, and whether `name` should ever be globally unique | Only if the app asks for it — rooms already separate cwds |

## Próximos planos

- **74 — `/remote-pi doctor`**: one command that joins the Wave 0 log, locks, broker UDS, relay and
  the last failure reasons (was candidate 71).
- **75 — broker UDS health/timeout**: if H1 (a wedged root) shows up in a real capture.
- Revisit **E2E / protocol** plans only if room derivation ever changes — this plan deliberately
  does not touch it.

## Dependencies / ordering

- **After** `plan/70` Wave B (B1–B4) and C (C1–C3) and the 0.7.1 publish: B3 already makes the
  collision loud, which P3 then makes intentional; landing P3 first would double the work.
- P4/P6 touch the `session_start` auto-init and `/remote-pi create` regions that upstream **#242**,
  **#236**, **#203** and **#217** also touch — re-run the same `git apply --check` guards used in
  `plan/70` before touching them, and never touch the two protected tests.
