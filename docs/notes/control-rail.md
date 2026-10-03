# Manager control rail

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## The manager control rail — `src/control.ts` (cotal 0.25)

**paw has exactly one door to the manager, and it is not `requestControl` any more.** cotal's 1d slice
DELETED the manager's bespoke `ctl.<tier>.<owner>.<actor>` subjects; control moved to the manager's v0.4
**service endpoint** on the `ep.*` rails. `src/control.ts` (`ManagerControl` / `withManagerControl`) is
the only place that speaks it, and `src/names.ts` deliberately holds no control constants any more.

**How the breakage hid, which is the part worth remembering.** `ep.requestControl(…)` still EXISTS on
the endpoint, so the 0.25 bump type-checked, passed all 20 hermetic suites and `check:loop`, and was
still wrong: it addressed a subject nobody serves. Worse, it did not fail — cotal's `requestControl`
uses `noMux` with a named reply subject, so it sat until its own 4s timeout while a RAW request to the
same subject drew `no responders` in ~1ms. "Nobody is home" and "still thinking" looked identical, which
is what turned a one-line diagnosis into an evening. Evidence, not reading: `grep -rn serveControl
node_modules/@cotal-ai/manager/dist` → **zero matches** in 0.25 (0.15 has it), and core's own
`controlCallerPermissions` says "the manager `ctl` rail is gone". The `manager-service-contract.js`
header still claims the two rails are "dual-served … until 1d deletes those" — **that prose is stale;
believe the code.**

**A control call is no longer one request.** It is: connect → `describe` the endpoint → fetch its §13.7
contract documents from the store → recompile the input/output validators (all of that is
`resolveService`) → `invokeCommand`. That costs a round trip plus a store read, so `ManagerControl`
RESOLVES ONCE and invokes many times — paw polls `ps` every 500ms while waiting for an agent, and
re-resolving per call would turn one readiness wait into dozens of describes. It is a thin port of
cotal's own `askManager` (`@cotal-ai/cli` `lib/control.js`), read rather than guessed at; paw carries
none of its operator I/O, `--on` instance pinning or user-bearer mode (one local manager per space, no
user auth).

**Op → command renames (v0.3 → v0.4):** `start`→**`spawn`**, the named `stop`→**`despawn`**, per-agent
`status`→**`inspect`**; `ps` unchanged. `despawn`/`attach` are **TARGETED**: they address an agent by its
principal TRIPLE `(owner, actor, lifecycleUid)`, never by alias, so each one first resolves the name via
`inspect` **on the same rail** (cotal mints `inspect`'s read row onto the same capability arm, so
resolving on another tier's connection would be a grant paw isn't holding). Mode is `any` (cross-agent
operator reach), matching cotal's own non-bearer `stop`.

**The PAW_AUTH tier caveat is finally closed.** `controlCreds` minted the PRIVILEGED tier and
stopAgent/restartAgent then rode it onto an ADMIN subject — under-privileged, and only ever working
because the open mesh enforces nothing. The tier is now chosen by the COMMAND (`ps`/`spawn`/`inspect` →
`control-caller-privileged`; `despawn`/`attach` → `control-caller-admin`), lazily, one rail per tier.
On an open mesh both tiers share ONE bare connection under a synthesized `DEV_OWNER` triple, because
there is no credential system to isolate. `controlCreds` survives for exactly one caller now: `paw
status`'s own JetStream inbox-lag read. **NOT verified live:** every authed path — no PAW_AUTH mesh was
stood up.

**SPAWN IS AN ACCEPTANCE, NOT AN OUTCOME (the sharpest edge).** Since cotal's P2 item 2 the `spawn`
reply returns as soon as the identity is ALLOCATED; the old `start` blocked until the agent was ready.
cotal offers `submitAndFollowGoal` to restore blocking and **paw deliberately does not use it** — the
reason is specific, not stylistic: paw's readiness wait is not passive. It polls `ps` and, on the tmux
runtime, presses Enter at claude's one-time dev-channels prompt on EVERY poll (`nudgeStartupPrompt`),
which is the only thing that unsticks a cold claude that reached the prompt after cotal's own 1s…5s
nudge window. Blocking inside the spawn call would suspend paw for exactly the window its only recovery
action needs. So `ensureAgentSpawned` takes the acceptance and then `waitForMeshLive`s for
`SPAWN_READY_MS` (60s — what the old blocking call was given), throwing loud if the agent never lands.
Consequence to keep in mind: a boot failure now surfaces as paw's readiness timeout, not as the
manager's own `ok:false`, so the message says "accepted but never reached the mesh" and points at
`paw status` / `paw log`.
**The reply's SHAPE changed too:** it is `{name, owner, actor, uid, goalId, …}`, so the agent's wire
principal is now STATED (`principalKey(owner, actor)`) rather than re-derived from a raw nkey by
`wirePrincipal` — which is strictly better, since paw no longer has to guess an owner. A reply missing
either token yields NO id (the caller falls back to waiting for presence), never a half-formed
principal.

**The readiness gate needed two changes, and the second is the subtle one.** `MANAGER_READY_MS` went
8s → **20s** (a resolve is a describe + store fetch + recompile, and none of it can succeed until the
manager finishes REGISTERING its service a few seconds after the process starts). But the fix that
actually mattered is `READY_PROBE_MS` (1.5s): `managerAnswers` runs in a RETRY LOOP, and with the
default 10s resolve deadline a single early attempt outlived the entire readiness window — one probe,
no retries, and a perfectly healthy manager reported as "didn't answer". Measured on an idle machine:
resolve ~450ms, `ps` ~310ms once registered.

**`sharedManagerControl(space, server)` — one handle per long-running process (2026-08-24).**
`withManagerControl` is right for a one-shot CLI (open → ask → close → exit). `paw web` called it
per POLL, so every 2s tick re-ran the whole resolve — describe + contract-store fetch + an Ajv
recompile of every validator — and cotal printed its `! schema: compile took ~110ms of process CPU`
advisory for each one (the "random errors" log of 2026-08-23; the advisory is cotal's own reference
budget observation, NOT a refusal — their comment says the number "was very nearly all instrument").
The shared handle resolves once; `collectStatus(space, ctl?)` takes it optionally (web passes it,
the `paw status` CLI keeps opening its own — a cached open socket would keep a one-shot process alive
past its last line). **Staleness:** the resolved service is per manager INSTANCE, so a manager restart
would leave the cached handle addressing a ghost; `ManagerControl.stale` flips on any transport-level
failure inside `invoke`/`invokeTargeted` (never on a refusal), and `sharedManagerControl` closes and
replaces a stale handle on the next call — one failed poll, not a wedged daemon. Verified live: web
under launchd, 0 advisories in 25s of polling (was ~12). NOT verified live: the stale→replace path
across a real manager bounce (would churn the live fleet).

**Staleness has TWO shapes, and the second one wedged the daemon for a day (2026-09-08).** cotal pins a
resolved service to the manager's registration EPOCH; a re-registration (same instance, epoch 45→46 — a
broker reconnect, the presence-KV rebuild after the outage) makes every later command come back as an
`ok:false` REFUSAL: "the caller bound to epoch 45 … this incarnation is not the one it resolved against".
Transport-only staleness never flipped, so `paw web` sat on the dead handle through ~10k refused polls
with rows frozen at 10:02 AM. Now `isStaleRefusal` (matched on cotal's own SPEC 13.2 wording, never on a
generic error — an unknown-agent refusal must not drop a good handle) flips `stale` from inside
`invoke`/`invokeTargeted`, and `paw web`'s `refreshStatus` additionally `dropSharedManagerControl`s on
ANY failure (one re-resolve is a few hundred ms; a wedged daemon is the alternative). Same day, same
cause, other symptom: after a fleet restart every agent has a NEW id, the web's presence watch was dead,
and an outgoing DM accepted before that id had been seen sending kept the raw id — the client's
optimistic row matches on the NAME, so it read `waiting 1m` while the message had long been delivered.
`Conversation` now re-resolves unnamed recipients on every read (`unnamed` map, live AND reconciled
history). Tests: `check:commands` (predicate), `check:web` (late naming).

**`paw open`'s pty attach is GONE upstream**, not merely unported — see the `src/open.ts` entry.

**Verified live** on an isolated space (`check:rail`): a manager started by one process answered `ps`
from three separate fresh processes in 340/311/309ms; unknown-name `inspect`/`despawn` refused in
216ms/1ms; and with `PAW_RAIL_SPAWN=1` a real claude spawned in 4.4s (`id=local.UBDG…`), appeared in a
separate process's `ps`, and despawned.
