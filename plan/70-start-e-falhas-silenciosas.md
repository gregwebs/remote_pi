# 70 — `/remote-pi start` e as falhas silenciosas do caminho root

**Objetivo**: acabar com a classe de falha em que o usuário roda `/remote-pi`
(e o verbo legado `/remote-pi start`) numa pasta que **já tem config com
`auto_start_relay: true`** e não acontece absolutamente nada — sem mensagem,
sem relay, sem mesh. O `status` manda "run /remote-pi to start"; o usuário
roda; silêncio.

Data do relato: 2026-10-14. Subprojeto alvo: `pi-extension/`.

---

## Contexto

### Relato (pi TUI num terminal)

Numa pasta **existente**, com `.pi/remote-pi/config.json` (`agent_name` +
`auto_start_relay: true`), a saída de `/remote-pi status` foi:

```
⚪ Local mesh: not connected
⚪ Relay: off (https://…/) — run /remote-pi to start
```

e `/remote-pi start` **não teve nenhum efeito**. Numa pasta nova, o mesmo
fluxo funcionou (wizard → config → conectado).

### O que já foi verificado (repro controlado, 2026-10-14)

1. **O caminho felizesce funciona com "pasta existente".** Com a 0.7.0
   instalada (`~/.pi/agent/npm/node_modules/remote-pi` == HEAD do repo), uma
   pasta temporária com `.pi/remote-pi/config.json` + `auto_start_relay: true`
   auto-conecta **sem nenhuma digitação** (auto-init no `session_start`):

   ```
   [remote-pi] Joined local mesh as "rp-repro" (follower)
   [remote-pi] Connecting to relay https://greg-mac-m1-1…/ (source: config, room: xz5HGT0E7FLM)…
   [remote-pi] 🟢 Local mesh: connected as "rp-repro" (2 peers)
               🟢 Relay: on, waiting for an app to connect
   ```

   ⇒ "pasta existente" **não é** a causa. A falha é dependente de estado e
   **ainda não foi reproduzida** (não temos `reason` dela).

2. **`/remote-pi start` não existe como subcomando.** A TUI corta o primeiro
   token como nome do comando (`commandName = text.slice(1, spaceIndex)`) e
   passa o resto como `args`; o dispatcher (`src/index.ts:2518-2542`) não tem
   branch `start` → cai no `else` final (`src/index.ts:2542`) → `_cmdRoot(ctx)`.
   `extension.test.ts:372-398` garante que `remote-pi start|list|add-relay`
   **não sejam registrados** (plano 19 removeu as cinco registrações), mas
   ninguém definiu o que fazer com o **argumento**. Pior: o docstring do topo
   (`src/index.ts:9`) e `plan/11`, `plan/12`, `plan/16`, `plan/17`, `plan/19`,
   `plan/26` e `.orchestration/contracts/pairing.md` ainda documentam
   `/remote-pi start`. O usuário está seguindo a nossa documentação.

3. **O caminho do root tem saídas sem uma linha de saída.** Inventário
   completo (candidatos à causa do relato, todos pré-existentes):

| Linha (`src/index.ts`) | Situação | Efeito visível |
|---|---|---|
| `:2542` | subcomando desconhecido (`start`, `list`, `add-relay`, typo) | roda o root; nenhum aviso de verbo inválido |
| `:2686-2688` | `_cmdRootInFlight` pendente | `/remote-pi` **bloqueia** atrás da promise, sem output nenhum |
| `:2693`, `:2696`, `:2703` | lifecycle/generation invalidada | `return` sem notify |
| `:2771`, `:2781`, `:2783`, `:2785` | wizard path invalidado no meio | idem |
| `:2796`, `:2800`, `:2802` | returning-user: lifecycle invalidada **ou `_cmdJoin` não publicou** | idem — **candidato nº 1** |
| `:4287` | `_cmdJoin`: connect resolveu, mas o candidato ficou stale | mesh nunca publica, sem notify |
| `:4331` | `_cmdJoin`: o join **falhou** e o candidato já estava stale | erro engolido |
| `:2854`, `:2892`, `:2981`, `:2996` | `_cmdStart`: candidato suplantado (stop / relay-off / start mais novo) | relay nunca sobe, sem notify |
| `:2378-2402` | auto-init `void _cmdRoot(initCtx)` | falha do auto-start é fire-and-forget (invisível) **e**, se essa promise travar, toda invocação posterior trava atrás dela (`:2686`) |

### Hipóteses, em ordem de probabilidade

| # | Hipótese | Como confirmar |
|---|---|---|
| H1 | O `_cmdRoot` do auto-init **travou** (join no mesh ou `relay.connect()` sem deadline) e `_cmdRootInFlight` ficou pendente para sempre ⇒ todo `/remote-pi`/`start` seguinte bloqueia mudo | log da Wave 0 (`root_begin` sem `root_end`) + C1/C2 |
| H2 | `_cmdJoin`/`_cmdStart` desistiram como **candidato stale** e o erro foi engolido (`:4287`/`:4331`) | log com `result=stale` + `reason` |
| H3 | Lock de `(cwd,name)` negado / loop de sufixos `#N` sem mensagem útil | log com `lock_result` |
| H4 | `relay.connect()` rejeitado ou lento (rede/Tailscale) num caminho que não notifica | log `relay_connect_*` + `_cmdStatus` com a razão |

Nenhuma dessas hipóteses é assumida como verdadeira: **o primeiro entregável
não é "consertar o bug X", é tornar a falha observável** — hoje é impossível
diagnosticar sem ler o fonte, e o usuário não tem como se desbloquear.

### Evidência capturada com o build instrumentado (2026-10-15)

Primeira captura real, na pasta do relato: `/Users/claude/code/agent-vm`
(config `agent_name=agent-vm`, `auto_start_relay=true` desde 13/10 11:58; é
**checkout normal**, não worktree).

**Como rodar — `-e` sozinho NÃO serve.** Com `npm:remote-pi` em
`~/.pi/agent/settings.json`, `pi -e <build>` colide nas tools
(`agent_send`/`list_peers`/`agent_request`), **sai com código 1 e não cria sessão**
⇒ nenhum registro no log (reproduzido). A forma que funciona é
`pi -ne -e <repo>/pi-extension/dist/index.js`: `-ne` desliga pacotes configurados e
`-e` explícito continua carregando (`docs/cli.md`). Verificado duas vezes (pasta sem
config ⇒ `decision=skip reason=no_local_config`; pasta do relato ⇒ lifetime completo).

**Log cru** (sessão nova na pasta do relato, `--mode rpc`, 15 s, saída limpa):

```
session_start_autoinit  decision=start
lock_result   result=refused  lockPath=…/locks/-FQSLDBwKvJt.sock
lock_result   result=ok       lockPath=…/locks/fESJvauu7yVp.sock
join_begin      → join_end          result=ok
relay_connect_begin → relay_connect_end result=ok
root_end  result=ok  reason=connected  name="agent-vm#2"  room="fESJvauu7yVp"
```

**O que isso prova:**

1. Gate de auto-init e config **não** são a causa desta pasta: sessão nova conecta
   mesh **e** relay (relay responde em ~24 ms). `no_cwd` não ocorre aqui — a pasta é
   checkout normal, não worktree (a hipótese do fallback `process.cwd()` do fork não
   explica este relato).
2. O lock primário (`agent-vm`) está **ocupado**: `-FQSLDBwKvJt.sock` (14/10 20:38)
   pertence à sessão viva **pid 46548** (`cwd=agent-vm`, 8 h), que também segura
   `sessions/local/broker.sock` e um TCP/TLS vivo para o relay ⇒ aquela sessão está sã.
3. A recusa cai no loop de sufixo `#N`: a sessão nova entra como **`agent-vm#2`**, em
   outra room, **sem nenhuma mensagem ao usuário**. Mesma classe de silêncio do
   relato — o usuário vê "não conectado"/identidade errada sem saber por quê.
4. A sessão **pid 46763** (`cwd=agent-vm`, 2 d 11 h) está exatamente no estado
   relatado: **sem** broker UDS, **sem** lock, **sem** TCP para o relay ⇒
   "⚪ Local mesh: not connected / ⚪ Relay: off". É a candidata a sessão de origem do
   relato; o que falta observar é o **caminho de recuperação** dessa sessão (o que
   `/remote-pi start` faz depois de perder mesh/relay) — o boot está são.

**Consequências para o escopo:** a recusa silenciosa de lock com troca de identidade
entra na Wave B como **B3**. A causa raiz fica **parcialmente** confirmada: a classe
(saídas silenciosas + lock/identidade) está provada com log cru; falta apenas observar
a sessão quebrada reagindo a `/remote-pi start` — o que B/C tornam impossível de ser
silencioso de novo.

**Segunda captura — pasta sem config (`/Users/claude/code/microsandbox`, 2026-10-15).**

Relato do usuário: `/remote-pi start` **e** `/remote-pi relay start` não fazem nada;
`status` mostra "not connected / Relay: off". Duas sessões pi abertas ali (22 h e 21 h).

- A pasta **não tem `.pi/` nenhum** (nem `.pi/remote-pi/config.json`); as duas sessões não
  seguram lock, nem `broker.sock`, nem TCP para o relay.
- Build instrumentado ali: `session_start_autoinit decision=skip reason=no_local_config`,
  título `Pi · Off` ⇒ estado **correto** para pasta não configurada.
- Por que os dois verbos são mudos: em 0.7.0 `start` **não é verbo** — cai no `else` final
  do dispatcher (`:2542`) e reimprime o status; e `relay start` chama `_cmdStart` direto
  (`:3424`), que não configura nada e retorna sem mensagem.
- O caminho que **funciona** (e que o próprio hint do `status` sugere) é o **root bare**:
  `/remote-pi` → `if (!localConfigExists(cwd))` ⇒ wizard de primeira vez
  (`_cmdRootInner`, `index.ts:2971-2990`), que salva a config e segue para o start; existe
  também `/remote-pi setup` (`_cmdSetup`, `:3040+`) para re-rodar o wizard. Sem UI
  interativa (`ui.select` ausente) esse caminho só chama `_cmdStatus(...)` e retorna —
  silêncio de novo.

**Conclusão das duas capturas:** são **dois** casos distintos por trás do mesmo relato, e
os dois são silenciosos por construção:

| Caso | Estado real | O que o usuário vê | Fix |
|---|---|---|---|
| Pasta **sem config** (`microsandbox`) | nada para conectar | "off" + `start`/`relay start` mudos | Wave A (`start`→alias do root, abre o wizard) + **B2** (sem UI: avisar em vez de só reimprimir status) |
| Pasta **configurada** com lock ocupado (`agent-vm`) | 2ª sessão recusada, entra como `#N` | "não conectado"/identidade errada | **B3** (lockPath do dono + identidade efetiva) + C1/C2 (deadlines) |

O relato original ("pasta já configurada, `status` off, `start` sem efeito") fica coberto
pelo segundo caso, mais o caminho de recuperação de uma sessão longeva que perdeu
mesh/relay — este último ainda sem observação direta (a sessão de origem pode ser a
`pid 46763`, que está exatamente nesse estado).

**Desfecho de `microsandbox` (11:21 Z, depois do wizard):** com a config criada, o probe
instrumentado faz o lifetime completo — `session_start_autoinit decision=start`,
`lock_result ok name=microsandbox lockPath=…/MX0sPOYm6CxD.sock`, `join_end ok`,
`relay_connect_end ok`, `root_end ok reason=connected` (room `MX0sPOYm6CxD`) em ~160 ms,
**sem recusa de lock**. A pasta estava sã; faltava o comando certo.

Lições de UX a manter no escopo:

- `/remote-pi setup` **só grava a config** e avisa `Config updated. Run /remote-pi to
  apply now.` (`_cmdSetup`, `index.ts:3050-3061`) — não inicia nada. Quem lê "setup"
  como "configura e conecta" fica com `status` off sem entender.
- Uma sessão **longeva** cuja partida não tinha config nunca auto-inicia depois: o
  `session_start` já passou, então exige o root manual. Isso é por design
  (`_autoInited`), e a 3ª linha do `status` da Wave 0 passa a nomear exatamente esse
  estado: `⚠️ Last start: skip — no_local_config (há …)`.
- Duas sessões na mesma pasta: só uma pega o lock primário; a outra cai em `#N`
  silenciosamente (B3).

**Terceira captura — `/remote-pi` e `relay start` mudos com `_state === "idle"`
(microsandbox, 2026-10-15, depois do wizard gravar a config).**

Nas duas sessões longevas (21-22 h) o usuário rodou `/remote-pi` **e**
`/remote-pi relay start`: nada aconteceu, e `status` continua
`⚪ Local mesh: not connected` + `⚪ Relay: off (…) — run /remote-pi to start`.

- Essa linha de relay só é emitida quando `_state === "idle"` (`_cmdStatus`) ⇒ **não** é o
  estado obsoleto `started` de `_onRelayClose` (que renderiza "reconnecting"). O processo
  está genuinamente idle, com `_relay === null` e `_meshNode === null`.
- Sessão **nova** na mesma pasta conecta (~160 ms, probe instrumentado) ⇒ o defeito é
  **estado por processo** numa sessão velha, não a pasta nem a config.
- Com `_state === "idle"`, os únicos retornos **mudos** restantes são:
  `if (!isCurrentCandidate()) return;` em `_cmdStart` (`!_disposed && generation ===
  _relayLifecycleGeneration && _state === "idle" && _relay === null`, `:3072+`) e, no root,
  os `if (!_isCurrentRootLifecycle(g)) return;` = `!_disposed && g ===
  _rootLifecycleGeneration` (`:1174`), além do `await _cmdRootInFlight` sem teto (`:2686`).
  ⇒ Restam duas hipóteses: **instância obsoleta/descartada** (`_disposed === true`, por
  substituição de sessão) **ou** `_cmdRootInFlight` pendente engolindo o root.
- **Discriminador:** `/remote-pi relay start` **não passa pelo root** — se não imprime
  absolutamente nada, o bail silencioso é o `isCurrentCandidate()` (instância descartada);
  se imprime algo, o problema é o root (H1). Vale perguntar também se houve `/new`,
  `/fork`, `/resume`, reload ou troca de sessão nessas janelas: o `session_start` só limpa
  `_disposed` quando o host reavalia o módulo (`:2450-2458`).

Item de escopo novo: **B4** (abaixo) — desistência por instância obsoleta/geração superada
nunca pode ser muda quando o comando veio do usuário.

**Resgate da sessão obsoleta (2026-10-15): `/reload` funciona.** O `session_start` do pi
dispara em *startup/new/fork/**reload**/resume* e o re-arm do módulo está logo no começo
do handler: `if (_disposed) { _disposed = false; void _cmdRoot(ctx, restartAuthority); }`
(`index.ts:2457-2462`). Ou seja: num host que **reusa** a instância, o reload limpa
`_disposed` e já re-roda o root; num host que **recria** o módulo (docs/extensions.md:50 —
"reload replaces the extension runtime"), o instance novo nasce com `_disposed = false` e
o auto-init do `session_start` assume. Nos dois casos a pasta (já configurada) conecta.
Alternativa verificada: sair e reabrir o pi (com o 0.7.0 instalado, o título vai a
`microsandbox · On` em ~1 s).

O usuário **não** usou `/new`, `/fork` nem `/resume` — logo o `_disposed = true` veio de um
teardown de sessão **sem** `session_start` correspondente (host que dispara substituição
in-process; o ambiente tem `@tintinweb/pi-subagents` e `@harms-haus/pi-worktrees`, e o
upstream #203 justamente toca o auto-init em L2395). É a assinatura exata que B4 passa a
nomear.

### Relacionados no upstream (varredura de issues/PRs em 2026-10-14)

**A nossa issue exata não está reportada.** Nada descreve "config + `
auto_start_relay: true` + `/remote-pi start` sem efeito". Mas três componentes
do sintoma **já têm report/PR abertos**, e um deles é candidato a causa raiz:

| Ref | Estado | Por que importa |
|---|---|---|
| [#128](https://github.com/jacobaraujo7/remote_pi/pull/128) "retry initial relay connect instead of stranding agents offline" | **PR aberto desde 2026-08-14** | Falha no `relay.connect()` **inicial** só notifica e retorna: o processo fica `idle` para sempre (o backoff existente só engata a partir de `_onRelayClose`). É literalmente "`Relay: off` e nada recupera". Toca `_cmdStart` (~L2986/L3003). **Candidato direto a causa raiz do relato** (relay/Tailscale fora no boot = notify enterrado no output de startup). Complementar à Wave C, não substituto |
| [#236](https://github.com/jacobaraujo7/remote_pi/issues/236) (issue) + [#242](https://github.com/jacobaraujo7/remote_pi/pull/242) (PR) "keep unconfigured session replacements idle" | **abertos** (PR de 2026-10-11, verificado contra main `9db4903`) | Bug espelhado no MESMO código de re-arm (`session_start`, `index.ts:2359`): o re-arm chama `_cmdRoot` sem checar config. O thread traz evidência de dano colateral — configs gravados pelo wizard inesperado com `agent_name` = input do editor (`/model`, `/skills list`) |
| [#119](https://github.com/jacobaraujo7/remote_pi/issues/119) "`/remote-pi relay url` e `relay stop` são inertes" | **fechada**, corrigida em `e55dcdd` | Precedente exato do nosso `:2542`: todo `/remote-pi relay …` caía no `else` do dispatcher e reimprimia o status, sem aviso. O mantenedor escolheu **implementar o verbo** (não remover da doc). `start`/`list`/`add-relay` nunca foram revisitados nessa passada |
| [#124](https://github.com/jacobaraujo7/remote_pi/pull/124) "clean up failed registration and release the broker path" | PR aberto | `register_ack timeout` quando existe listener de broker mas o processo não responde; sessão fica "idle brokering the mesh while it reported `join failed`". Alimenta H1/H2 (`_cmdJoin`) |
| [#53](https://github.com/jacobaraujo7/remote_pi/pull/53) "coalesce concurrent startup" | fechado | Origem do `_cmdRootInFlight` — o wedge de C1 é o preço aceito daquele design, nunca revisitado |
| [#36](https://github.com/jacobaraujo7/remote_pi/pull/36), [#196](https://github.com/jacobaraujo7/remote_pi/issues/196)/[#207](https://github.com/jacobaraujo7/remote_pi/pull/207), [#216](https://github.com/jacobaraujo7/remote_pi/issues/216)/[#203](https://github.com/jacobaraujo7/remote_pi/pull/203) | fechado / abertos | Precedentes de "verbo documentado faltando" (`rename`), de crash no wizard, e de sessão in-process (subagents) mexendo no auto-init (`#203` toca L2395). Relevante porque o host do usuário roda `@tintinweb/pi-subagents` |

**Nenhum PR aberto cobre o escopo do plano 70:** varridos os 35 PRs abertos, os que
tocam `src/index.ts` na região do root/dispatcher são #242 (L2359), #217 (L2294),
#204 (L2346/L2448), #203 (L2395), #202 (L2442), #213 (L2931) e #128
(L2986/L3003) — todos **adjacentes** (re-arm/auto-init/`_cmdStart`), nenhum mexe
no dispatcher (`:2518-2542`), no silêncio das saídas do root, nem adiciona
alias/aviso de verbo desconhecido. ⇒ sem duplicação de trabalho, mas **rebase
obrigatório**: #242 e #128 mexem nas mesmas linhas que as Waves A/B/C vão tocar.

> Ruído à parte: a enxurrada de PRs de `peerDependencies` (#241, #213, #212,
> #201, #197, #169 vs issues #239/#247/#200) aparece como warning no boot do
> `pi` do usuário, mas não tem relação com esta falha.

### Fork `pungggi/remote_pi` (checado 2026-10-14)

É outro produto ("Piper", relay LAN por default, branding próprio), merge-base
`dafa0959` (junho) e **248 à frente / 256 atrás** do upstream; reestruturado
(`src/main.ts` 5.6k linhas + `src/extension-state.ts` + entry fino em
`src/index.ts`), v0.8.0, e a própria doc do fork proíbe PR pro upstream a partir
da `main`. Não é candidato a merge; é candidato a **portar delta**.

**O que o fork já resolve (e nós não):**

1. **#128 portado** — `e70e999f` (2026-08-27, "retry initial relay connect …
   (upstream #128) (#57)"), incluindo o edge case levantado no PR #128 (limpar
   retry pendente na entrada de `_cmdStart`): `main.ts:1518-1522` e
   `_scheduleInitialConnectRetry` em `main.ts:1684+`.
2. **#124 portado** — `e8d8ca05` (2026-08-27); tem `session/socket_owner.ts`,
   `socket_owner_windows.ts` e `peer.test.ts`.

**O que o fork NÃO resolve (mesmo código que o nosso):** dispatcher com o mesmo
fall-through (`main.ts:2939`), sem aliases e sem aviso de verbo desconhecido;
`_cmdRoot` com o mesmo `await ext.cmdRootInFlight` sem teto (`:3032-3034`); as
mesmas saídas silenciosas (`:3039/3042/3049/3067/3117`); `_cmdJoin` engolindo a
falha de candidato stale (`:4396`); re-arm **sem** a guarda de config
(`:2832-2838`, ou seja #236/#242 não aplicado); `_cmdStatus` só com as duas
linhas (`:2951-2987`). ⇒ Escopo do plano 70 continua inédito.

**Delta do fork que vale portar (ajuda direto o relato):**

- **Gate de auto-start com fallback de `cwd`.** O fork cai para `process.cwd()`
  quando o ctx de `session_start` não traz `cwd` (`fork/src/index.ts:638-648`),
  com comentário citando o sintoma exato: *"Some session shapes arrive without
  `cwd`, which left freshly-spawned worktree pis idle (\"Relay: off\")"*. O nosso
  gate (`index.ts:2385-2400`) exige `cwd` e **pula o auto-start em silêncio** —
  é uma manifestação conhecida do relato, e o host do usuário roda
  `@harms-haus/pi-worktrees`. **Entra na Wave 0** (virar caso de teste +
  logado).
- **#128** (retry do connect inicial). Caminho mais barato: **mergear o PR #128
  upstream** (aberto desde 14/08) em vez de reimplementar; portar do fork só
  enquanto ele não entrar.

---

## Estrutura esperada

```
pi-extension/src/
├── session/root_diagnostics.ts        # NOVO — módulo puro, sem dep do SDK:
│                                      #   _rootOutcome { at, result, reason, detail }
│                                      #   appendLifecycleLog(entry) (best-effort, nunca lança)
│                                      #   lifecycleLogPath() = ~/.pi/remote/logs/remote-pi.log
├── session/root_diagnostics.test.ts   # NOVO
├── index.ts                           # dispatcher de verbos + _cmdRoot/_cmdRootInner/
│                                      # _cmdJoin/_cmdStart (razões) + _cmdStatus (3ª linha)
├── extension.test.ts                  # testes de dispatcher + regressões de silêncio
└── README.md                          # tabela de comandos (verbos legados)
```

`~/.pi/remote/logs/remote-pi.log` — append-only, 1 linha JSON por evento
(`ts`, `event`, `reason`, `generation`, `cwd`, `room`, `name`, `pid`).
Reusa o padrão já existente em `src/daemon/cron_log.ts` (mkdir best-effort).

---

## Passos

### Wave 0 — instrumentar (não muda comportamento) ⚠️ bloqueia todo o resto

- **0.1 — log de ciclo de vida.**
  Eventos mínimos: `session_start_autoinit` (`decision=start|skip`,
  `reason=no_cwd|print_mode|already_inited|no_local_config|auto_start_relay_false`),
  `root_begin`, `root_end` (`result=ok|failed|stale|timeout`, `reason`),
  `lock_result` (`ok|refused`, `lockPath`), `join_begin/join_end`,
  `relay_connect_begin/end`.
  **Aceite**: nos 4 cenários (sem config / `auto_start_relay: false` / config ok
  / relay inalcançável) o arquivo tem a linha correspondente com `reason`
  preenchido; nenhum caminho de erro do log lança (teste com FS read-only).

- **0.2 — `_cmdStatus` conta o porquê.** Quando o estado não é tudo `🟢`,
  acrescentar 3ª linha:
  `⚠️  Último start: <reason> (há Ns) · log: ~/.pi/remote/logs/remote-pi.log`.
  **Aceite**: com `_rootOutcome` gravado, a linha aparece; sem gravação, é
  omitida; snapshot do formato nos testes existentes de `status` atualizado.

- **0.3 — capturar a causa raiz real.** Rodar o build instrumentado
  (`pnpm build` + `pi -e <repo>/pi-extension/dist/index.js`) na pasta do
  usuário que falha, repetir o relato e **anotar este plano** com a seção
  "Causa raiz confirmada" (log cru + linha culpada).
  **Aceite**: seção preenchida, ou — se não reproduzir — 0.1 já basta pra
  capturar na próxima ocorrência (pedir ao usuário pra repetir com o build
  instrumentado). **Precisa do caminho exato da pasta** → pedir ao usuário.

  **Status (2026-10-14): armado.** Sem pasta de repro; o log da Wave 0 (incl. `reason=no_cwd` com `process.cwd()`/`has_config` no `detail`) captura uma nova ocorrência com o build instrumentado — a falha antiga sem log não é recuperável. Fallback `process.cwd()` do fork adiado até corroborar o cwd da sessão/worktree, não apenas `has_config=true`.

### Wave A — verbos legados e verbo desconhecido (mata o silêncio `:2542`)

- **A1 — aliases explícitos**: `start|up|on` → `_cmdRoot` (mesma coisa, mas
  logado como alias); `list` → `_cmdList`; `add-relay <url>` → `_cmdSetRelay`;
  `sessions|join|leave` → aviso "removido no 0.7 — use X".
  (**Precedente**: foi o que #119/E `e55dcdd` fez com a família `relay`;
  alternativa rejeitada lá foi só corrigir a doc.)
- **A2 — verbo desconhecido nunca roda o root**: notify
  `[remote-pi] Subcomando desconhecido "<x>". Run /remote-pi para o status ou
  /remote-pi help para a lista.` + sugestão por prefixo/Levenshtein.
  `/remote-pi` **sem argumentos** continua sendo o root.
  **Aceite**: teste de dispatcher para cada caso (incl. `start`, `list
  <nada>`, `add-relay http://x`, typo `statu`); o teste de contagem de
  comandos registrados (`extension.test.ts:372`, hoje 23) só muda se A1/A2
  adicionarem registro — se mudar, atualizar a contagem **e** o comentário.
- **A3 — documentação alinhada**: corrigir o docstring `src/index.ts:9`
  (`/remote-pi` no lugar de `/remote-pi start`) e adicionar linha de alias na
  tabela do `README.md` do pi-extension. Os planos antigos ficam como estão
  (histórico), mas `plan/00-decisions.md` ganha a decisão "verbos legados são
  alias, nunca no-op silencioso".

### Wave B — o root nunca desiste em silêncio

- **B1 — toda saída grava razão.** `_cmdRootInner`, `_cmdJoin` e `_cmdStart`
  passam a gravar `_rootOutcome` em cada `return` (inclusive os de stale/superseção).
- **B2 — invocação do usuário sempre termina em output.** `_cmdRoot` ganha
  `origin: "auto" | "user"`. Para `origin="user"`: toda saída termina em
  `_cmdStatus(ctx)` + (se `result !== "ok"`) um `notify(..., "warning")` com a
  razão. Para `origin="auto"`: silêncio só quando `result=stale`; `failed`
  avisa uma vez.

  > **Interpretação do dono (2026-10-15, após revisão adversarial do plano):**
  > "termina em output" é satisfeito por **qualquer** mensagem visível já
  > emitida — inclusive um `error` do passo que falhou ou o `info`
  > "Setup cancelled." — e **não** obrigatoriamente por um `warning`. O que
  > segue valendo, sem enfraquecer, é **nunca ficar mudo**: todo caminho que
  > hoje não emite mensagem alguma numa invocação do usuário passa a emitir
  > (é a classe B4 + o `relay start` superseded). Isto é **interpretação** do
  > texto acima, registrada aqui para não passar por cumprimento literal.
  **Aceite**: teste que força `_cmdJoin` a falhar com candidato stale ⇒
  `/remote-pi` emite warning + `status` mostra a razão (hoje: silêncio).
- **B3 — lock recusado nunca é silencioso.** Quando `acquireCwdLock` recusa o lock
  primário e o loop de sufixo assume um `#N`, o usuário precisa ver: o `lockPath` do
  **dono** do lock, o nome/room em uso agora (`agent-vm#2`) e o aviso de que passou a
  ser **outra identidade**. Hoje: recusa + troca de identidade sem mensagem alguma
  (capturado com log cru em 2026-10-15, ver "Evidência capturada").
  **Aceite**: `/remote-pi` numa pasta cujo lock primário está ocupado emite warning com
  `lockPath` do dono + identidade efetiva; `status` mostra o `reason` do lock; o log já
  registra os dois `lock_result` e o `name` final (não regredir).
- **B4 — instância obsoleta nunca é muda.** Desistências por `!isCurrentCandidate()`
  (`_cmdStart`/`_cmdJoin`) e por `!_isCurrentRootLifecycle` (`_cmdRootInner`) numa invocação
  do **usuário** passam a notificar **uma vez**, com `reason=disposed|lifecycle_superseded`,
  mais a instrução prática ("reinicie o pi: esta sessão ficou com a instância antiga").
  Hoje: retorno silencioso (`:1174`, `:3072+`) — capturado em 2026-10-15 (microsandbox, com
  `_state === "idle"` provado pela própria linha do `status`).
  **Aceite**: teste que marca `_disposed = true` (ou supera a geração) e invoca o root ⇒
  exatamente um warning com o motivo; idem para `relay start`; nenhum warning quando a
  invocação é `origin="auto"` e o resultado foi `stale`.

### Wave C — um root travado não pode engolir o próximo comando

- **C1 — `_cmdRoot` não espera para sempre** (`:2686`): se
  `_cmdRootInFlight` estiver pendente, notificar `still connecting… (Ns)` e
  retornar; limpar a referência quando a geração é invalidada
  (`_cmdStop`, `_goIdle`, `session_shutdown`).

  > **Escopo do dono (2026-10-15):** só o **núcleo** entra — espera limitada
  > (`ROOT_IN_FLIGHT_WAIT_MS = 500`, < 1 s) com aviso, e **nunca mudo**. As
  > corridas apontadas pela revisão **têm** de ser corrigidas junto:
  > revalidação pós-espera (autoridade + epoch da sessão + identidade em voo
  > *atual*), posse atômica de um start novo (dois comandos que ignoram a
  > mesma run superseded não podem entrar juntos no loop de lock — isso
  > reproduz o `#2` silencioso que esta wave existe pra matar) e seleção de
  > outcome por geração (um `root_end` velho não pode sobrescrever o de uma
  > run mais nova). O **drain** do restart continua **sem bound** (keychain,
  > wizard, `close`) e **não pode ser descrito como limitado** — ver
  > "Próximos planos".
- **C2 — deadlines nos awaits que podem travar**: `_cmdJoin` (`MeshNode.connect`)
  e `_cmdStart` (`relay.connect()`) com timeout (sugestão: 20 s) → no timeout
  fechar o candidato (`peer.close()` / `relay.close()`), gravar
  `reason=join_timeout|relay_timeout` e avisar.

  > **ADIADO (2026-10-15):** só a metade do **relay** entra (deadline dentro do
  > `RelayClient.connect()`, que cancela limpo: `ws.terminate()` +
  > `this.ws = null`). A metade do `_cmdJoin` **não** entra: um join que
  > estoura o prazo hoje **não** pode ser cancelado de verdade —
  > `SessionPeer._joinOrLead()`/`_registerAsClient()` prendem o socket
  > *depois* dos awaits sem rechecar `leftFlag` (`src/session/peer.ts:306-334`),
  > então o timeout deixaria broker/peer vivo atrás. Vai pro plano de
  > cancelamento (ver "Próximos planos") — até lá, **não** prometer
  > `join_timeout`.
- **C3 — `acquireCwdLock`**: teto de tempo total no loop de sufixos `#N` e
  mensagem sempre com o `lockPath` do dono do lock.

  > **ADIADO (2026-10-15):** a metade do **teto de tempo total** não entra — a
  > checagem de relógio do loop só roda *entre* tentativas e o bind de
  > `acquireCwdLock` não tem timeout, então um teto real exige semântica de
  > cancelamento (inclusive devolver lock adquirido depois do estouro). Entra
  > só a **mensagem**: toda falha de lock nomeia o `lockPath` do dono. O teto
  > vai pro plano de cancelamento.
  **Aceite**: teste com `peer.connect()` que nunca resolve ⇒ `/remote-pi`
  responde com aviso em <1 s e um join posterior bem-sucedido **não** fica
  bloqueado (regressão do `_cmdRootInFlight`).

### Wave D — testes e release

- **D1** unit: verbos (Wave A), razões persistidas (B1/B2), hang/timeout (C1/C2),
  razões do auto-init logadas (0.1).
- **D2** `pnpm typecheck && pnpm test && pnpm build`.
- **D3** **pacote publicado**: o usuário roda `npm:remote-pi` (0.7.0) em
  `~/.pi/agent/npm/node_modules/remote-pi`, então nada disso chega até ele sem
  bump + publish (ciclo do `plan/27`) + `pi update --extensions`.

---

## Workaround imediato (documentar no chat, não substitui o fix)

- `/remote-pi relay start` — chama `_cmdStart` direto (`src/index.ts:3424`),
  **sem passar pelo `_cmdRootInFlight`**; sobe o relay mesmo se o root estiver
  travado (o mesh local não é re-joinado por esse caminho).
- `/remote-pi status` continua funcionando (não passa pelo root).
- `ls ~/.pi/remote/locks/` + `lsof -a -p <pid> -d cwd` mostram quais agentes
  seguram lock/socket.

---

## Revisão adversarial do plano e decisões do dono (2026-10-15)

O plano de implementação das Waves B/C passou por revisão adversarial
independente antes de virar código: **veredito `reject`** com 10 achados
bloqueantes (contrato de reporte enfraquecido; `_runStart` podendo reportar uma
tentativa superseded como sucesso; B1 sem cobrir chamadores diretos e o retry
do #128; snapshot de autoridade antes do await; perda de coalescing ao ignorar
run superseded → corrida de lock/`#2`; "bounded by C2/C3" falso; `peer.close()`
não cancela eleição em curso; B3 anunciando identidade reservada em vez da
efetiva; teto do C3 não sendo teto; isolamento de teste gravando no HOME real).

A revisão **confirmou** o que era a premissa central do plano: a banda
conservadora `(2834,3103)` do guard é exatamente `_cmdStart` (assinatura até a
chave final; próxima função `_cmdPair` na 3114), as janelas dos patches #128/#242
estão corretas e nenhum insert proposto viola banda/clearance.

Decisões do dono aplicadas ao plano revisado (`implementation-plan.rev2.md`, em
`/tmp/rp-plan70/bc/`, junto de `plan-review.md` e `owner-rulings.md`):

- **B2 pragmático** — qualquer mensagem visível conta como output; fica valendo
  o *nunca mudo* (nota em B2 acima).
- **Cancelamento estreito** — entra só o que cancela limpo (deadline do relay,
  mensagens do C3, núcleo do C1); join deadline, teto do C3 e bound do drain
  ficam para o plano de cancelamento (ver "Próximos planos").
- **C1 mantém o núcleo**, com as corridas da revisão corrigidas.

---

## Definition of Done

- [x] 0.1 log de ciclo de vida gravando nos 4 cenários, sem lançar em FS read-only
- [x] 0.2 3ª linha de `_cmdStatus` com `reason` + idade
- [x] 0.3 causa raiz do relato confirmada e anotada neste plano (ou captura armada esperando a próxima ocorrência) — armada via log da Wave 0; causa raiz não confirmada, sem pasta de repro
- [x] A1/A2 aliases + verbo desconhecido com aviso (testes de dispatcher)
- [x] A3 docstring + README + decisão no `plan/00-decisions.md`
- [x] B1/B2 nenhuma saída do root sem output quando o usuário invocou (output = qualquer
      mensagem visível — ver interpretação registrada em B2); toda saída do root/join/start
      tem razão terminal registrada, inclusive exceção e stale (posse por `outcomeId`)
- [x] B3 recusa de lock visível (lockPath do dono + **identidade efetiva publicada**, não só
      o candidato reservado pelo lock); inclui rename bem-sucedido, rename falho e rename
      de mesmo nome (no-op não destrutivo)
- [x] B4 instância obsoleta avisa (`reason=disposed|lifecycle_superseded`); a metade
      "disposed" está coberta por unidade (sem gatilho real dirigível em RPC), a metade
      superseded foi verificada e2e
- [x] C1 núcleo: espera limitada (500 ms, medido 505 ms) com aviso, nunca mudo, sem as
      corridas (revalidação pós-espera, posse atômica, outcome por geração)
- [x] C2 relay half: deadline no `RelayClient.connect()` com `reason=relay_timeout`
      (medido 20,02 s contra servidor TCP que aceita e não faz upgrade)
- [x] C3 half: toda falha de lock nomeia o `lockPath` do dono
- [ ] **Adiados (não fazem parte desta entrega, por decisão do dono em 2026-10-15):**
      join deadline do `_cmdJoin`, teto total do loop `#N`, bound do drain do restart —
      candidato **plano 74**; nada disso foi implementado nem prometido

### Verificação independente (2026-10-15)

- Revisões adversárias de código (3 rodadas) com reprodução real e checagem de mutação;
  achados corrigidos: B1 (rename falho publicando identidade), B2 (nó fechado anunciado
  como vivo + `lifecycle_superseded` fictício), B3 (dependência de `/tmp/rp-plan70` no
  suite), stage errado no `Still connecting…`, G1 (`stop` sem autoridade sobre rename em
  voo) e F-A (modo print mudo).
- Verificação e2e com sessões `pi -ne -e` reais e `REMOTE_PI_HOME` isolado: happy path
  (`· Off` → `· On`), pasta sem config nunca muda, deadline do relay, duas sessões na
  mesma pasta (aviso com lockPath do dono + identidade `#2`), espera duplicada em 505 ms,
  verbos legados/desconhecidos, formato do log.
- Relatório: `/tmp/rp-plan70/bc/verification-report-2.md` (e os demais artefatos em
  `/tmp/rp-plan70/bc/`).
- [x] D2 `pnpm typecheck && pnpm test && pnpm build` verdes
- [ ] D3 publicado (0.7.1) e validado no `pi` do usuário na pasta que falhava

## Próximos planos (candidatos)

- **71 — Doctor do mesh/relay**: comando único (`/remote-pi doctor`) que junta
  o novo log, o estado dos locks, o broker UDS, o relay e as últimas falhas —
  hoje o diagnóstico está espalhado entre `status`, `peers`, `config` e logs
  do supervisor.
- **72 — Timeout/health do broker UDS**: se a H1 se confirmar, o mesh merece
  health check próprio (join-ack com deadline, re-eleição de líder quando o
  broker não responde), não só um timeout no chamador.
- **74 — Cancelamento real do caminho de mesh** (herda os adiados das Waves B/C
  de 2026-10-15): (1) deadline do `MeshNode.connect()` no `_cmdJoin` **junto**
  de uma fence de cancelamento em `SessionPeer`/`MeshNode` — rechecar
  `leftFlag`/`closed` depois da eleição e do registro (`src/session/peer.ts:306-334`),
  senão a tentativa "cancelada" deixa broker/peer vivo; (2) teto de tempo total
  no loop de sufixos `#N`, incluindo devolver lock adquirido depois do estouro
  (bind de `acquireCwdLock` sem timer hoje); (3) bound do **drain** do restart
  (keychain, wizard, `close` não têm deadline: `_cmdStart`, `_cmdRootInner`).
  (4) Depois que o #128 entrar, decidir como o retry
  `_scheduleInitialConnectRetry → void _cmdStart(ctx)` volta a atualizar
  `_rootOutcome` — hoje ele passa por fora do wrapper e fica sem registro.
