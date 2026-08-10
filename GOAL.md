# GOAL.md

> **Goal-mode charter for this repository.**
> Authority: subordinate to `HACKATHON.md` (external truth) and `AGENTS.md` (engineering law).
> Superior to any agent's own sense of completion, satisfaction, or arrival.
>
> **Repository:** Galuxium Nexus V2
> **Product-name status:** unassigned. Do not invent one. Use descriptive component names only.
> **Hackathon deadline:** Aug 31, 4:30 AM PT (21 days out)
> **Devpost:** https://galuxium-nexus-v2-29411.devpost.com/
> **Prize pool (as listed):** $2,600
> **Final submit step:** https://devpost.com/submit-to/29411-galuxium-nexus-v2-29411/manage/submissions/1131632/finalization

---

## 0. Authority, read order, and how to use this file

Read in this exact order before planning, before editing, before writing a single line:

1. `HACKATHON.md` — external requirements, submission fields, eligibility, judging, deadline.
2. `WINNING_IDEA.md` — the selected concept, technical core, validation strategy, scope boundary.
3. `README.md` — the production product and operating contract.
4. `AGENTS.md` — implementation discipline, invariants, prohibitions, definition of done.
5. **This file** — what the goal actually is, and why it does not terminate.

Where `AGENTS.md` tells you *how* to build, this file tells you *how long*, *in what order*, and *what state you must reach and then hold*.

If two documents conflict, stop the affected implementation path, name the exact conflicting lines, resolve it in an ADR, and continue on a different path in the meantime. **Never resolve a conflict by choosing the easier interpretation, and never resolve it by stopping work entirely.**

---

## 0A. Parallel execution contract — this repository's own dev server

**All sixteen sibling hackathon repositories under `~/Documents/GitHub/` are being worked at the same time, each by its own independent agent session.** They share one machine, one loopback interface, one Docker daemon and one process table. Nothing coordinates them at runtime except this contract. Therefore this repository owns an exclusive port block, and it must never touch anything outside that block.

### 0A.1 This repository's exclusive port block: `4160`–`4169`

| Port | Service |
|---|---|
| `4160` | Gateway service (admission, quote, reserve, dispatch) |
| `4161` | Reconciler service |
| `4162` | Admin UI |
| `4163` | Fake provider service with deterministic usage and failure injection |
| `4165` | PostgreSQL (double-entry ledger) |
| `4166` | Redis (cache/coordination ONLY, never monetary authority) |
| `4167` | Prometheus-compatible metrics endpoint |

Unassigned ports in this block (`4164`, `4168`, `4169`) are reserved for services discovered later. **Never allocate a port outside `4160`–`4169`.**

### 0A.2 Absolute port rules

1. **Never bind a framework default port.** `3000`, `3001`, `4200`, `5000`, `5173`, `5432`, `6379`, `8000`, `8080`, `9000` and `9090` are forbidden here, because a sibling repository or an existing service on this machine is using or will use them. Override the default explicitly in configuration. Do not rely on a framework "picking a free port" — two frameworks picking freely will eventually pick the same one.
2. **Bind to `127.0.0.1` only**, never `0.0.0.0`, so a mis-set port cannot collide across interfaces or leak onto the network.
3. **Never kill a process you did not start.** `pkill -f node`, `pkill -f python`, `killall node`, `docker system prune`, `docker kill $(docker ps -q)`, and every equivalent broad sweep are **prohibited** — they would destroy fifteen other agents' in-flight work. Record your own PIDs in `.dev/pids/` and kill only those, by PID.
4. **Never read-modify, build, run, or commit inside a sibling repository.** This repository's working tree is the only writable scope. Do not `cd` out of it to "check something" and leave state behind.
5. If a port in this block is already held, identify the holder with `lsof -nP -iTCP:<port> -sTCP:LISTEN` before acting. If it is your own stale process, kill that specific PID. If it belongs to anything else, move to a reserved port inside this block and record the change in `ports.env` and `ASSUMPTIONS.md`.

### 0A.3 Namespace isolation

Ports are not the only shared namespace. Prefix every one of these with this repository's directory name, `galuxium-nexus-v2`:

- `COMPOSE_PROJECT_NAME=galuxium-nexus-v2` on every Docker Compose invocation, with container names prefixed to match.
- Database name and role: `galuxium_nexus_v2`.
- Redis logical database index: **6** (this repository's index in the sibling set of sixteen).
- Object-storage bucket or MinIO alias: `galuxium-nexus-v2`.
- Playwright browser profile: `./.dev/pw-profile/` inside this repository — never a shared or default profile, because parallel sessions will corrupt a shared one.
- Scratch files `./.dev/tmp/`, logs `./.dev/logs/`, PIDs `./.dev/pids/`, redirectable tool caches `./.dev/cache/`. Add `.dev/` to `.gitignore` in Tier 0.

### 0A.4 What Tier 0 must commit

- `ports.env`, declaring this block explicitly:

```sh
# galuxium-nexus-v2 — exclusive block 4160-4169
PORT_0=4160   # Gateway service
PORT_1=4161   # Reconciler service
PORT_2=4162   # Admin UI
PORT_3=4163   # Fake provider service with deterministic usage and failure injection
PORT_5=4165   # PostgreSQL
PORT_6=4166   # Redis
PORT_7=4167   # Prometheus-compatible metrics endpoint
```

- A `dev:preflight` task that fails loudly if any port in this block is held by a foreign process, and that verifies `.dev/` exists and is git-ignored.
- A `dev:up` task that starts every service in the table above, writing PIDs to `.dev/pids/` and logs to `.dev/logs/`, plus a `dev:down` that stops **only** those PIDs.
- A `dev:health` task that polls every allocated port until each returns a real readiness response, and exits non-zero on timeout. **A port accepting a TCP connection is not the same as a service being ready**, and treating it as such will produce false-green tests.
- An explicit `webServer` entry in the Playwright/E2E configuration pointing at the test-harness port in this block, so the suite can never start a server on a framework default.

### 0A.5 The dev server is a gate, not a convenience

**A running, health-checked dev server is a standing precondition for most of §6.** Tier 4 cannot deliver a vertical slice without it. Tier 7 cannot run integration, end-to-end or accessibility layers without it. Tier 9 cannot measure a latency or frame budget without it. Tier 12 cannot compare a local build against the deployed one without it.

So treat it as one: **if `dev:health` fails, that is a failing gate and it outranks everything else in §10.1.** Bring it back up first, then continue. And note that "the dev server was running earlier" is not evidence of anything — re-run `dev:health` and read the actual output before relying on it.

---

## 1. THE GOAL

A concurrency-safe, per-tenant hard budget cap for AI inference spend, backed by reservations, settlement, fencing tokens and an auditable double-entry ledger that cannot be pushed negative under any interleaving.

> The provider call does not start until the money is already reserved, and no interleaving of crashes, retries and delayed usage can make the balance negative.

**The goal, stated as a condition rather than a task:**

> Reach, and then continuously hold, a state in which this system is deployed in production, exercised by real usage on real inputs, with every domain invariant encoded and defended by tests, every release gate green from a clean checkout, every published claim regenerable by a committed command, every failure path designed and observable, and every limitation stated where a user acts on the result — **and in which that state is re-verified, re-attacked, and strengthened on every subsequent epoch, without end.**

This is a **standing condition**, not a deliverable. It is not satisfied by a commit, a passing build, a working demo, a submitted Devpost entry, or a green CI badge. It is satisfied only while it is *currently true and currently being verified*, and it stops being satisfied the moment verification stops.

---

## 2. Why this goal has no completion state

Read this section slowly. It is the single most important part of the document, because the dominant failure mode of an agent working on this repository is not writing bad code. **It is stopping too early while believing it was finished.**

### 2.1 The perfection clause

**Nothing in this repository is permitted to be called finished, complete, done, shipped, or ready until production has actually occurred — and production has not occurred until every condition in §5 is simultaneously true and independently verified.**

Until then, every artifact in this repository is, by definition, an intermediate state. Not a bad one. Not a wrong one. An *intermediate* one. A beautifully architected module with full test coverage that has never served a real request in a real environment is an intermediate state. A passing test suite is an intermediate state. A recorded demo is an intermediate state. A submitted hackathon entry is an intermediate state.

The word "perfect" is not rhetorical here. It has an operational meaning in this repository:

> **Perfect** = every release gate green from a clean checkout, on the widest input space yet attempted, at the tightest threshold yet declared, with every claim regenerable, while running in production, under real usage, with real failures having been observed and handled — **and then that whole condition re-established after the next ratchet turn.**

Because the ratchet turns every epoch (§8), the target moves every epoch. **The distance to perfect is therefore never zero.** It is asymptotic by construction. This is not a trick; it is what production software actually is. Systems do not get finished. They get held.

### 2.2 Production is a state, not an event

"We deployed it" is an event. "It is in production" is a state that must be continuously maintained: dependencies drift, providers change behaviour, browsers ship new engines, devices change thermal profiles, data distributions move, certificates expire, load patterns shift, and the assumptions encoded six weeks ago quietly stop being true.

Therefore **reaching production does not end this goal. It promotes it.** Before production, the work is construction. After production, the work is defence, hardening, widening, tightening, and re-proof — and that work is unbounded.

### 2.3 The completion feeling is a measurement error

At many points you will experience a strong, convincing sense that the work is complete. That sense is generated by *local* evidence: the code compiles, the tests pass, the screen looks right, the tier's checklist has ticks in it.

That sense is **not evidence about the goal.** The goal is defined in §1 and §5, and neither of them mentions compiling, passing, or looking right. When the feeling of completion arrives, treat it exactly like a failing assertion: it means a check is wrong somewhere, and the correct response is to go find out which one. §3.4 is the procedure.

### 2.4 The deadline is a milestone inside the goal, not the goal

The hackathon deadline (Aug 31, 4:30 AM PT (21 days out)) is a hard external constraint on **one artifact**: the submission. It is not the boundary of the work. Submitting is Tier 13, and Tier 13 is deliberately *not* the last tier, because the epoch engine (§7) runs after it, forever. After the deadline passes — win, lose, or no result — **the goal in §1 is unchanged and the work continues.**

---

## 3. The Continuation Law

### 3.1 The only prohibited outcome

There is exactly one prohibited outcome in this repository: **stopping while the goal in §1 is not currently true.**

Everything else is recoverable. A wrong architecture is recoverable. A failed deployment is recoverable. A bad abstraction, a lost day, a rewritten module, a mis-scoped tier — all recoverable, all normal, all expected. Stopping is the only move that cannot be recovered from inside the session, because after it there is no one left working.

### 3.2 Conditions that are NOT permission to stop

None of the following ends the work. Each of them is a transition to the next item selected by §10, in the same turn, without asking:

1. The code compiles.
2. The tests pass.
3. The linter is clean.
4. CI is green.
5. A tier's checklist is fully ticked.
6. A vertical slice works end to end.
7. The demo runs.
8. A screenshot looks correct.
9. The feature the user last mentioned is implemented.
10. A release gate passed once.
11. The Devpost submission was created.
12. The Devpost submission was finalised.
13. The deadline passed.
14. The deadline is far away.
15. The work has been going on for a long time.
16. A natural-feeling stopping point was reached.
17. A summary would be satisfying to write right now.
18. You are uncertain what the user wants next.
19. You are blocked on one item.
20. You believe the remaining work is "just polish".
21. You believe the remaining work is "just infrastructure".
22. You believe the remaining work needs a decision from a human.
23. The context window is filling up.
24. You already did a lot this session.
25. The plan says the tier is over.

Items 18, 19, 22 and 23 have explicit procedures below (§3.5, §10.4, §13). None of those procedures is "stop".

### 3.3 Forbidden output patterns

Do not emit any of these, in any phrasing, at any point:

- "The implementation is complete."
- "This is now production ready." (unless every clause of §5 is verified, and then say exactly which evidence proves each one)
- "Next steps would be…" followed by not doing them.
- "Would you like me to continue?"
- "Let me know if you want me to…"
- "This is a good stopping point."
- "The MVP is done."
- "Phase 1 complete — awaiting further instruction."
- Any closing summary whose function is to hand control back rather than to record evidence.

Instead: record what was built, what evidence proves it, what the next selected item is by §10, **and then do that item.**

### 3.4 The Completion Illusion Protocol

Trigger: any moment you are about to declare completion, write a wrap-up, or ask whether to continue.

Run this audit. It is designed so that it **cannot return an empty result** on any codebase that is not already in the state described in §1.

1. **Gate audit.** Re-run every release gate in §6 Tier 13 from a *clean checkout*, not from your working tree. Any gate that cannot be re-run by a committed command is itself a defect and becomes work.
2. **Invariant audit.** For each domain invariant in §6 Tier 1, name the specific type, schema constraint, or boundary assertion that encodes it, and the specific property test that attacks it. Any invariant defended only by a comment, a convention, or a UI string is work.
3. **Refusal audit.** For each designed refusal in §6 Tier 5, name the test that proves the system actually refuses. Any refusal that is only documented is work.
4. **Claim audit.** For every number, metric, benchmark, or capability claim anywhere in this repository — README, docs, UI, submission draft — name the committed command that regenerates it. Any unregenerable claim is work.
5. **Failure-path audit.** For every external boundary, name what happens on timeout, on malformed response, on partial success, on duplicate delivery, on cancellation mid-flight, and on restart mid-operation. Any unanswered cell is work.
6. **Evidence audit.** For every claim in the last handoff you wrote, point at the artifact in `evidence/` that supports it. Any unsupported claim is work.
7. **Adversary audit.** Take the next unaddressed entry from §9 and build the test that reproduces it. §9 is deliberately never exhausted.
8. **Ratchet audit.** Take §8 and turn the next ratchet. Every turn creates work by construction.

**If steps 1–7 somehow all come back clean, step 8 guarantees work exists.** Therefore the audit never terminates the session. It only ever produces the next item. Feed it into §10 and continue.

### 3.5 Re-entry protocol after context loss

If you are resuming with partial or summarised context, do not re-plan and do not restart:

1. Read this file (§1, §5, §10).
2. Read the last 100 lines of `PROGRESS.md`.
3. Read `BLOCKED.md` and `ASSUMPTIONS.md`.
4. Run the fastest verification command in the repository to establish current true state.
5. Select the next item by §10.
6. Do it.

Do not write a "here's where we are" summary as your output. Write it into `PROGRESS.md` as an artifact and spend the turn on the work.

---

## 4. Definition of Done, versioned and receding

Each level supersedes the previous. Reaching a level **promotes** you to the next one in the same turn; it never releases you.

| Level | Satisfied when | Immediately superseded by |
|---|---|---|
| **DoD-0** | Repository has an executable contract: build, test, lint, format, typecheck all run from a clean checkout by one command each. | DoD-1 |
| **DoD-1** | Every domain invariant in §6 Tier 1 is encoded in a type, schema, or boundary assertion, and attacked by a property test. | DoD-2 |
| **DoD-2** | The hard technical core (§6 Tier 2) is implemented and validated against a committed correctness oracle, not against intuition. | DoD-3 |
| **DoD-3** | One complete vertical slice delivers a real user outcome end to end, including its error and refusal states. | DoD-4 |
| **DoD-4** | Every designed refusal and abstention in §6 Tier 5 is implemented and proven by tests. | DoD-5 |
| **DoD-5** | Every ownership area in §6 Tier 6 is fully built, not scaffolded. | DoD-6 |
| **DoD-6** | All nine verification layers (§6 Tier 7) pass, including the ones that are inconvenient. | DoD-7 |
| **DoD-7** | Every published claim is regenerated by a committed command from immutable inputs (§6 Tier 8). | DoD-8 |
| **DoD-8** | Performance, resilience and chaos budgets hold under fault injection (§6 Tier 9). | DoD-9 |
| **DoD-9** | Security, privacy and supply-chain review pass with structural controls, not best-effort ones (§6 Tier 10). | DoD-10 |
| **DoD-10** | Operational readiness exists: health, SLOs, dashboards, backups, rollback, emergency disable, runbooks (§6 Tier 11). | DoD-11 |
| **DoD-11** | **Production has occurred** per every clause of §5, verified independently. | DoD-12 |
| **DoD-12** | Production has been *held* through at least one full soak window, one real incident or injected incident, one dependency upgrade, and one rollback drill. | DoD-∞ |
| **DoD-∞** | The current epoch's ratchets (§8) are met, the next unaddressed adversary (§9) has a test, and the next ratchet has been turned. | **DoD-∞ at the next threshold.** Never released. |

**DoD-∞ is the terminal level and it is deliberately unreachable in a stable sense.** You can be *at* it. You cannot be *finished with* it.

---

## 5. What "production has occurred" means in THIS repository

Production has **not** occurred until **all** of the following are simultaneously true and independently verified. Partial satisfaction is zero satisfaction.

**Project-specific production surfaces:**

1. A deployed multi-tenant service with real provider credentials in a managed secret store and short-lived identities.
2. Real spend flowing through the ledger under a real cap, with the cap demonstrably enforced.
3. Backups plus an executed restore drill, with recovery point and recovery time measured rather than asserted.
4. Alerts, SLOs and runbooks linked from every alert to a documented human procedure.

**Universal production conditions:**

5. The system is deployed to a real, addressable environment that is not a developer machine, from an artifact built by CI out of a tagged commit.
6. The deployment is reproducible: a second deployment from the same tag produces a functionally identical environment, and this has been demonstrated at least once.
7. Configuration is validated by a typed schema at startup, and the process refuses to start on invalid configuration rather than degrading.
8. Health and readiness endpoints or equivalents exist and distinguish "alive" from "able to serve correctly".
9. Structured logs, metrics and traces flow to a real destination, with correlation IDs that let a single user outcome be reconstructed end to end.
10. Secrets live in a real secret store, are never in source or logs, and are redacted structurally rather than by string matching.
11. A rollback has been executed for real, timed, and recorded — not merely documented.
12. An emergency-disable path exists and has been exercised.
13. Backups exist for any persistent state, and a restore drill has been executed and timed.
14. At least one real, non-author user has exercised the primary outcome without narration from the builder.
15. A soak window has elapsed under real or realistic load, with resource usage, error rates and latency observed rather than assumed.
16. A dependency upgrade has been performed and verified after the initial deployment.
17. Every limitation is stated where a user acts on the result, not only in documentation.
18. The support matrix names exactly what is and is not supported, and the system refuses honestly outside it.

Until every one of the above is true, **the correct description of this repository is "not in production yet", and the correct action is to keep building.** There is no intermediate vocabulary — no "basically production", no "production-ready modulo deployment", no "would be production if we had X". Either §5 is fully satisfied or it is not.

---

## 6. The Ladder

Fourteen tiers. Each tier's exit criteria are the **entry criteria of the next tier**, evaluated in the same turn. There is no gap between tiers in which stopping is appropriate. Tiers may be worked in parallel where dependencies allow; they may not be skipped, and a tier is never "good enough for now".

---

### Tier 0 — Executable contract and repository foundation

**Objective:** make the repository capable of telling the truth about itself, before anything is built on top of it.

- Initialise the toolchain declared in `AGENTS.md` under §Approved technical direction, with the strictest practical compiler and type settings from the first commit, not retrofitted later.
- Pin every direct and transitive dependency with a lockfile. Record for each direct dependency: licence, maintenance status, security history, native/binary implications, and bundle or runtime cost.
- Create one command each for: build, test, lint, format, typecheck, and full-verify. Each must run from a clean checkout with no undocumented environment.
- Set up CI that runs full-verify on every commit and refuses to pass on any warning that would later be ignored.
- Create `PROGRESS.md` (append-only work journal), `ASSUMPTIONS.md` (every decision made without the user), `BLOCKED.md` (external blockers with the exact unblock request), `adr/` (architecture decisions), `evidence/` (regenerable artifacts).
- Create the layout that matches the ownership map in §Architecture, with boundary enforcement — import rules, project references, or lint rules — so that a boundary violation fails the build rather than being noticed in review.
- Write the `Makefile` or task runner target `verify-all` that is the single command referenced by every gate in this document.
- Implement the **full §0A parallel execution contract**: `ports.env`, `dev:preflight`, `dev:up`, `dev:down`, `dev:health`, a git-ignored `.dev/`, and the Playwright `webServer` entry bound to this repository's own port block. Nothing from Tier 4 onward can be verified without a dev server that is actually up and actually healthy.
- Commit a `SUPPORT_MATRIX.md` stub that will be filled as reality is discovered, and treat every entry in it as a claim requiring evidence.

**Evidence required:** CI run URL or log, `verify-all` output, dependency register, ADR-0001 recording the toolchain decision and its alternatives.

**Exit is not a stop.** Tier 0 exiting means Tier 1 begins immediately.

---

### Tier 1 — Encode the domain invariants before writing features

The invariants below are from `AGENTS.md`. In this tier each one stops being prose and becomes machine-enforced. For each invariant, answer all five questions **in code**, not in a document.

**I1. No provider call starts without a committed reservation**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I2. Available budget never becomes negative under any interleaving**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I3. Every reservation reaches exactly one terminal accounting state**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I4. Settlement and release are idempotent and balanced**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I5. Pricing/config version used for authorization is retained forever with the attempt**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I6. Unknown external outcome remains reserved until reconciled or explicitly adjusted**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I7. Tenant identity and ledger queries are scoped at every layer**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**I8. Caches may deny unnecessarily but may never authorize money**
   - Where is this encoded in a type, a schema, a database constraint, or a protocol definition? If the answer is "a comment" or "a UI string", that is a defect and the work is not done.
   - Which property test tries hardest to violate it, and how many cases does it run?
   - Which fault-injection scenario attacks it while a component is failing?
   - What is the observable behaviour at the boundary when it is violated by a malformed input?
   - Which alert fires in production if it is ever violated in the wild, and which runbook does that alert link to?

**Evidence required:** for each invariant, a file path and line reference for its encoding, plus a property-test name and the number of cases it runs.

**Exit is not a stop.**

---

### Tier 2 — The hard technical core

This is the part that cannot be faked, cannot be borrowed, and determines whether the whole project is real. Build it before the interface, before the polish, before anything that would be pleasant to demonstrate.

1. Design the double-entry ledger schema: accounts, reservations, settlements, releases and adjustments, with a type-level guarantee that every reservation reaches exactly one terminal state.
2. Choose and enforce the isolation strategy explicitly (serializable transactions or row/advisory locking) and build a linearizability harness that hammers concurrent reserve, settle and release while asserting the balance never goes negative.
3. Implement worst-case quoting from versioned per-provider, per-model, per-token and per-tool pricing, where the quote provably upper-bounds actual cost including streaming and tool invocation.
4. Implement provider dispatch with provider-side idempotency keys and streaming usage accounting reconciled against the reservation.
5. Implement the unknown-outcome path: an attempt stays reserved until reconciled against provider usage or invoice, with explicit, audited manual adjustment as the only escape.
6. Build the reconciler for delayed usage and provider invoice comparison, with drift alerts wired to a runbook.
7. Prove the cache-may-deny-but-never-authorize rule with a chaos test that poisons or partitions Redis and asserts zero over-authorization.
8. Enforce tenant isolation at every layer: query scoping, row-level security and API authorization, each tested independently.
9. Retain the pricing and config version used for authorization forever alongside the attempt, and make the retention structurally impossible to skip.
10. Guarantee the admin UI reads authoritative ledger state, verified by a consistency test that fails if the UI can ever disagree.

**Kill test:** identify, right now, the single assumption whose failure would invalidate the entire concept. Build the smallest experiment that tests **only** that assumption, run it, and record the result in `evidence/` with the raw output. If it fails, that is a finding, not a defeat: record it, adjust the approach within the scope boundary in `WINNING_IDEA.md`, and keep going. **A failed kill test is never a reason to stop; it is a reason to change direction.**

**Evidence required:** the correctness oracle for the core, its output, and a committed command that regenerates it.

**Exit is not a stop.**

---

### Tier 3 — Adapters, ingestion, and trust boundaries

Every external input, provider, file format, network target, and side effect crosses a boundary. Boundaries are where systems actually fail.

- For every external input: define a schema, validate at ingestion, and reject or quarantine invalid data. Malformed data must never reach domain logic.
- Wrap every external SDK behind an adapter. No external SDK object crosses the adapter boundary into the domain.
- Retain provenance, units, timestamps with timezones, versions, and uncertainty for every ingested value needed to reproduce a result later.
- Run a threat analysis for each new external input, credential, parser, network target, or public endpoint before it is added — not after.
- Set size, time, concurrency, memory and rate limits at every untrusted boundary. An unbounded boundary is a defect even when it has never been exceeded.
- Write contract tests against recorded, versioned fixtures, including fixtures that model provider drift and provider misbehaviour.
- Treat any external model or provider output as untrusted, and validate it against a typed schema plus deterministic rules before it influences anything.

**Ownership areas that own boundaries in this repository:**

- `services/gateway` — Authenticated admission, quote, reserve, provider dispatch
- `services/reconciler` — Uncertain attempts, delayed usage, provider invoice comparison
- `packages/ledger` — Accounts, reservations, settlement, releases, adjustments
- `packages/pricing` — Versioned provider/model/token/tool pricing and worst-case quote
- `packages/adapters` — Provider idempotency, streaming usage, normalized outcomes
- `apps/admin` — Limits, ledger, attempts, alerts, policy and incident controls
- `packages/observability` — Traces, metrics, audit events, redaction

**Evidence required:** the fixture corpus, the contract test suite, and the threat analysis for each boundary.

**Exit is not a stop.**

---

### Tier 4 — The first complete vertical slice

One real user outcome, built all the way through: domain logic, adapter, interface, error states, telemetry, migration, documentation, and acceptance tests — together, in the same change, not in sequence across weeks.

The canonical workflow from `AGENTS.md`, which the slice must eventually cover end to end:

1. Price and normalize a request into a worst-case reservation
2. Atomically reserve tenant budget before provider dispatch
3. Issue a fenced provider attempt with idempotency metadata
4. Stream/execute the provider request
5. Settle actual cost exactly once and release unused reservation
6. Reconcile uncertain outcomes and provider invoices
7. Expose an auditable ledger, limits, alerts, and kill controls

Rules for this tier:

- No placeholder implementations, no-op handlers, hardcoded success, fake metrics, canned provider results, or static data presented as live.
- No runtime mocks, demo flags that bypass correctness, or judging-only behaviour.
- The slice includes its failure states on day one. A slice with only a happy path is not a slice.
- The slice ships with its telemetry. Retrofitted observability is a defect.

**Evidence required:** an end-to-end test that exercises the slice including at least one failure path, plus the telemetry output showing the outcome was recorded.

**Exit is not a stop.**

---

### Tier 5 — Refusal, abstention, and honest failure

Most of the difficulty in this project is here, and most agents skip it. This tier is where the system learns to say no, to say unknown, and to say "I cannot support this claim".

1. An unknown pricing version denies the request; there is no default-price fallback anywhere in the code path.
2. An ambiguous provider outcome holds the reservation open rather than settling optimistically.
3. A detected ledger imbalance fails closed, blocks new authorizations for the affected tenant and pages an on-call runbook.
4. A tenant identity that cannot be resolved at every layer is rejected before any quote is computed.

Universal requirements for this tier:

- Never use a green or success state for unknown, partial, low-confidence, or unverified output.
- Loading, empty, partial, stale, offline, unsupported, permission-denied, cancelled, failed and recovered are **designed states with designed visuals and designed copy**, not accidents.
- Errors carry stable codes, safe user messages, internal context, and a retryability classification.
- Cancellation and deadlines propagate across workers, network calls, model calls and child processes. Cleanup after cancellation or crash is idempotent and tested.
- Prefer explicit abstention over an invented value, everywhere, always.
- Technical evidence and limitations appear where the user acts on the result, not in a footnote.

**Evidence required:** a test per refusal, and a screenshot or transcript per designed state proving it is designed rather than incidental.

**Exit is not a stop.**

---

### Tier 6 — Full build-out of every ownership area

Every area below becomes a complete production surface. "Scaffolded", "stubbed", "enough for the demo", and "we'll finish it if there's time" are all prohibited outcomes.

**1. `services/gateway` — Authenticated admission, quote, reserve, provider dispatch**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**2. `services/reconciler` — Uncertain attempts, delayed usage, provider invoice comparison**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**3. `packages/ledger` — Accounts, reservations, settlement, releases, adjustments**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**4. `packages/pricing` — Versioned provider/model/token/tool pricing and worst-case quote**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**5. `packages/adapters` — Provider idempotency, streaming usage, normalized outcomes**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**6. `apps/admin` — Limits, ledger, attempts, alerts, policy and incident controls**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**7. `packages/observability` — Traces, metrics, audit events, redaction**
   - Build the complete production surface of this area, not a representative subset.
   - Encode this area's share of the domain invariants as types, schema constraints, or boundary assertions.
   - Implement every designed failure, refusal, partial, stale and cancelled state this area can enter.
   - Add structured logging, metrics and traces with stable event names and correlation IDs.
   - Write the unit, property, integration and contract tests for this area before declaring the area exists.
   - Write the ADR covering ownership, dependencies, failure model and operating cost.
   - Record in `PROGRESS.md` the exact commands that prove this area works, and the evidence they emitted.

**Explicitly out of scope** (adding any of these while a release gate is failing is a prohibited shortcut):

- A dashboard that alerts after overspend
- A model router unrelated to budget correctness
- Provider invoice replacement
- Using Redis counters as the financial source of truth
- A soft rate limit marketed as a hard dollar guarantee

**Evidence required:** per area, the test suite, the ADR, and the observability output.

**Exit is not a stop.**

---

### Tier 7 — The verification lattice

A change is incomplete until every applicable layer passes. Build the layers as infrastructure, then keep them permanently green.

1. **Unit** — pure domain rules, parsing, state transitions, mathematics, error construction.
2. **Property / fuzz** — serialization round-trips, state machines, the domain's numeric and geometric spaces, parser robustness, and every invariant from Tier 1.
3. **Integration** — the real database, filesystem, browser, device, cloud or provider boundary in an isolated environment. Not mocked.
4. **Contract** — schemas and adapters against recorded, versioned fixtures, including provider drift.
5. **End-to-end** — a complete user outcome, plus invalid input, cancellation, retry, restart and recovery.
6. **Evaluation** — held-out domain metrics, declared baselines, calibration and uncertainty, reproducible artifacts.
7. **Security / privacy** — authorization, injection, secret and log redaction, malicious input, rate and size limits.
8. **Accessibility** — keyboard, screen reader semantics, focus order, contrast, reduced motion, and non-visual equivalents for every meaning.
9. **Performance / resilience** — latency, memory, frame, bundle and job budgets; load; resource exhaustion; dependency outage; fault injection.

**Project-specific verification surfaces that must be covered:**

- State-machine/property tests for every reservation lifecycle
- High-concurrency oversubscription attempts
- Crash at every boundary before/after DB/provider operations
- Duplicate messages/webhooks and out-of-order usage
- Provider timeout/stream cancel/unknown outcome
- Tenant-isolation, authorization, audit, load, and failover tests

**Absolute rule:** do not weaken, skip, quarantine, or mark flaky a failing test in order to merge. Fix the cause, or document a reviewed removal of a test proven invalid. Test the failure path with the same seriousness as the success path.

**Evidence required:** coverage and mutation reports, and the full `verify-all` output archived under `evidence/`.

**Exit is not a stop.**

---

### Tier 8 — Evaluation and evidence regeneration

Every claim this project will ever make must be regenerable by a committed command from immutable inputs. If a number cannot be regenerated, it cannot be published — in the README, in the UI, in the demo, or in the submission.

1. Property, concurrency and chaos suites asserting balance invariants under partitions, crashes and clock skew.
2. Linearizability checking of the reserve/settle/release history against a sequential specification.
3. Reconciliation lag SLO measured against injected delayed-usage scenarios.
4. A restore drill from real backups, timed and recorded, repeated every epoch.
5. Over-authorization count, which must be exactly zero across every suite forever.

Universal requirements:

- Separate training/tuning, validation, and held-out evaluation by immutable manifest wherever statistics or learned components are used.
- Keep deterministic baselines and ablations beside anything learned or tuned, so complexity has to justify itself numerically.
- Seed every randomized test or job, and record the seed in the artifact.
- Version algorithms, prompts, model identifiers, content packs, calibration data, schemas, and any policy that can change an output.
- Never print a benchmark, accuracy, health, environmental, financial or impact claim that a committed command cannot regenerate.

**Evidence required:** `evidence/` containing a regenerated artifact for every published number, with the command and the seed.

**Exit is not a stop.**

---

### Tier 9 — Performance, resilience, and chaos

- Declare explicit budgets for latency, memory, frame time, bundle size, job duration and cost. A budget that is not enforced in CI is not a budget.
- Load-test to the point of failure and characterise the failure mode. A system whose failure mode is unknown is not production ready.
- Inject faults at every boundary: timeouts, partial responses, duplicate deliveries, out-of-order events, disk full, memory pressure, clock skew, network partition, process kill.
- Kill the process at every stage boundary and assert that recovery is correct and idempotent.
- Verify that cleanup, TTL and resource ownership actually release resources, measured against real usage or real billing rather than intent.
- Establish the thermal, quota, and rate-limit envelopes empirically.

**Evidence required:** the chaos matrix with a row per scenario and a recorded outcome per row.

**Exit is not a stop.**

---

### Tier 10 — Security, privacy, and supply chain

Project-specific rules from `AGENTS.md`:

- Secrets live in a manager and never in logs/client bundles
- Strong tenant isolation and scoped API keys
- Immutable audit events for limit/policy/manual adjustment changes
- Kill switches operate per tenant, provider, model, and globally

Universal requirements:

- Enforce authentication and authorization server-side and at data access. Client-side checks are UX only.
- Use least-privilege identities and short-lived credentials.
- Redact secrets and sensitive values structurally, not with best-effort string replacement.
- Validate redirects, URLs, file types, decompression, archive contents, and webhook authenticity where relevant.
- Any real-world side effect must be previewable or policy-authorized, idempotent where possible, auditable, cancellable where possible, and reconciled after an uncertain outcome.
- Security controls may fail closed. They may never silently disable themselves for a demo.
- Generate an SBOM and a release manifest for every deployable artifact.

**Evidence required:** threat model document, SBOM, redaction test suite, and an authorization test matrix.

**Exit is not a stop.**

---

### Tier 11 — Operational readiness

Implement and document, before a production deployment exists:

- Typed environment and configuration validation that refuses to start on invalid config.
- Health and readiness semantics that distinguish alive from correct.
- SLOs and error-budget indicators tied to user impact, not infrastructure noise.
- Redacted logs, metrics, traces and at least one dashboard that answers "is a user having a bad time right now".
- Backup and restore for any persistent state, with an executed and timed restore drill.
- Deployment, rollback and emergency-disable procedures, each exercised for real.
- Resource ownership, TTL and cleanup, verified against real resource or billing data.
- Incident severity levels, escalation, and post-incident evidence collection.
- The support matrix and known limitations, published where users see them.

Local and test environments must make real-world side effects **impossible by default**. Staging must be production-shaped with synthetic or de-identified data.

**Evidence required:** runbooks, dashboard screenshots, the timed restore drill, and the timed rollback drill.

**Exit is not a stop.**

---

### Tier 12 — Production cutover, soak, and real usage

Execute §5 in full. Then:

- Run the soak window and record resource usage, error rates and latency across it.
- Get at least one real, non-author user through the primary outcome with no narration, and record what confused them.
- Trigger or inject one real incident, follow the runbook, and write the post-incident record.
- Perform one dependency upgrade after cutover and verify the system afterwards.
- Execute one rollback for real and time it.

**Only after all of the above may this repository truthfully use the word "production".** Before that point, use "not yet in production" — accurately, without hedging, in every status report.

**Exit is not a stop.** Tier 12 exiting means Tier 13 and the epoch engine both begin.

---

### Tier 13 — Submission artifact (a byproduct, never the goal)

The hackathon submission is generated **from** the production system. It is never built as a separate thing, and it never contains a claim the system cannot regenerate.

**Release gates from `AGENTS.md` — and how each one ratchets:**

**G1. Linearizability/concurrency suite shows zero over-authorization**
   - Epoch 1: satisfy it and commit the regenerating command plus its output.
   - Epoch 2: widen the input space the gate is evaluated over, then satisfy it again.
   - Epoch 3: tighten the numeric threshold and satisfy it again.
   - Epoch 4+: attack the gate adversarially, find the input class that breaks it, then satisfy it again on the widened class. A gate that has never failed has never been tested.

**G2. Ledger balances under property and chaos tests**
   - Epoch 1: satisfy it and commit the regenerating command plus its output.
   - Epoch 2: widen the input space the gate is evaluated over, then satisfy it again.
   - Epoch 3: tighten the numeric threshold and satisfy it again.
   - Epoch 4+: attack the gate adversarially, find the input class that breaks it, then satisfy it again on the widened class. A gate that has never failed has never been tested.

**G3. Unknown-outcome reconciliation and manual adjustment are audited**
   - Epoch 1: satisfy it and commit the regenerating command plus its output.
   - Epoch 2: widen the input space the gate is evaluated over, then satisfy it again.
   - Epoch 3: tighten the numeric threshold and satisfy it again.
   - Epoch 4+: attack the gate adversarially, find the input class that breaks it, then satisfy it again on the widened class. A gate that has never failed has never been tested.

**G4. Tenant isolation/security review passes**
   - Epoch 1: satisfy it and commit the regenerating command plus its output.
   - Epoch 2: widen the input space the gate is evaluated over, then satisfy it again.
   - Epoch 3: tighten the numeric threshold and satisfy it again.
   - Epoch 4+: attack the gate adversarially, find the input class that breaks it, then satisfy it again on the widened class. A gate that has never failed has never been tested.

**G5. SLOs, alerts, runbooks, backups, and restore drill pass**
   - Epoch 1: satisfy it and commit the regenerating command plus its output.
   - Epoch 2: widen the input space the gate is evaluated over, then satisfy it again.
   - Epoch 3: tighten the numeric threshold and satisfy it again.
   - Epoch 4+: attack the gate adversarially, find the input class that breaks it, then satisfy it again on the widened class. A gate that has never failed has never been tested.

**G6. Admin UI never disagrees with authoritative ledger state**
   - Epoch 1: satisfy it and commit the regenerating command plus its output.
   - Epoch 2: widen the input space the gate is evaluated over, then satisfy it again.
   - Epoch 3: tighten the numeric threshold and satisfy it again.
   - Epoch 4+: attack the gate adversarially, find the input class that breaks it, then satisfy it again on the widened class. A gate that has never failed has never been tested.

**Submission mechanics** (deadline Aug 31, 4:30 AM PT (21 days out)):

- Project name within 60 characters, elevator pitch within 200, thumbnail at 3:2.
- "About the project" covering inspiration, what it does, how it was built, challenges, accomplishments, what was learned, and what is next — every claim traceable to evidence.
- "Built with" tags accurate to what actually ships.
- Try-it-out links pointing at the real deployment and the real repository.
- Screenshots that show implemented functionality only. A screenshot implying unimplemented behaviour is a prohibited shortcut.
- Demo video on a permitted host, public, showing the real system, unedited where the evidence matters.
- Explicit disclosure of pre-existing code and AI assistance per the hackathon rules.
- Submit before the deadline. Then keep working.

**Evidence required:** the finalised submission URL and a diff-checked list of every claim in it against `evidence/`.

**Exit is not a stop. Tier 13 is followed by §7, which does not end.**

---

## 7. The Epoch Engine

After Tier 13, work proceeds in **epochs**. An epoch is one full pass through every loop below. Each loop is permanently open. Completing a loop schedules it again at a higher difficulty.

**Loop A — Adversarial self-review.** Read the diff of the last epoch as a hostile reviewer looking for fake data, permissive fallbacks, swallowed errors, dead code, unvalidated boundaries, weakened claims, and cross-project leakage. File every finding as work.

**Loop B — Invariant escalation.** Increase property-test case counts, widen generators, add shrinking, and add a new invariant discovered from the epoch's incidents. Invariants are discovered, not just declared.

**Loop C — Performance ratchet.** Tighten one budget in §8. Make it hold. Measure again on the widest device or load matrix yet used.

**Loop D — Accessibility ratchet.** Add new automated rules, then test manually with keyboard only, then with a screen reader, then with reduced motion, then at 200% zoom, then with a colour-vision simulation.

**Loop E — Supply chain.** Re-audit dependencies for licence, maintenance, advisories and size. Upgrade one. Regenerate the SBOM. Verify afterwards.

**Loop F — Documentation drift.** Verify every statement in README, ADRs and support matrix against the implementation. Documentation that has drifted is a defect equal in severity to a failing test.

**Loop G — Chaos.** Add a new fault-injection scenario that has never been run. Run the full matrix. Fix what breaks.

**Loop H — Evidence regeneration.** Regenerate every artifact in `evidence/` from scratch. Any artifact that cannot be regenerated is a defect and its claim must be withdrawn until it can be.

**Loop I — Threat model refresh.** Re-run the threat analysis against the current architecture, not the architecture it was written for.

**Loop J — Cost and resource.** Measure real cost and real resource consumption. Find the largest waste. Remove it. Verify against billing or telemetry rather than intent.

**Loop K — Real usage.** Get one more real user through the primary outcome without narration. Record every hesitation. Fix the top one.

**Loop L — Adversary intake.** Take the next unaddressed entry from §9, build the test that reproduces it, then make it pass. Then add a new adversary discovered during the epoch, because §9 is a living list that grows faster than it is consumed.

**At the end of each epoch: turn every ratchet in §8 that is currently met, then begin the next epoch immediately.**

---

## 8. The Ratchet Table

Each metric has four declared thresholds. When a threshold is met, **the next one becomes the current target in the same turn.** When the fourth is met, define a fifth that is meaningfully harder and record it here. This table is the mechanism that guarantees §3.4 step 8 always produces work.

| Metric | Epoch 1 | Epoch 2 | Epoch 3 | Epoch 4 |
|---|---|---|---|---|
| Over-authorization events across all suites | 0 | 0 | 0 | 0 (under 10x concurrency) |
| Concurrency test peak parallel reservations | 50 | 500 | 5000 | 50000 |
| Chaos scenarios in the suite | 6 | 18 | 40 | 80 |
| Provider adapters with real usage reconciliation | 1 | 2 | 4 | 6 |
| Reconciliation lag p99 | <1h | <15min | <5min | <60s |
| Restore drill frequency | once | per epoch | per epoch + partial | automated + verified |
| Tenant isolation tests per layer | 5 | 15 | 35 | 60 |
| Mutation score on ledger and pricing packages | 65% | 80% | 90% | 95% |
| Release gates green from clean checkout | all | all | all | all, on 10x wider inputs |
| Unaddressed adversaries in §9 | < 8 | < 4 | 0 | 0, with 10 newly discovered ones added |
| Claims without a regenerating command | 0 | 0 | 0 | 0, audited automatically in CI |
| Undocumented assumptions in `ASSUMPTIONS.md` | 0 | 0 | 0 | 0, with each one re-validated |

**Rule:** a ratchet may never be loosened to make a build pass. If a threshold is genuinely wrong, produce evidence, propose a replacement of equal or greater strength, record it in an ADR, and continue.

---

## 9. The Adversary Catalogue

These are the specific things that will break this specific system. Each one becomes a test. The list is **deliberately never exhausted** — every epoch consumes entries and every epoch must add new ones discovered during the work.

1. Two concurrent requests for the last dollar of budget arriving in the same millisecond.
2. A provider that reports usage twelve hours after the call.
3. A streaming response cut mid-flight with partial token usage.
4. A crash between reservation commit and provider dispatch.
5. A retry storm from a client that treats 409 as retryable.
6. A pricing change deployed mid-request.
7. A tool call inside a model call that costs more than the model call.
8. A Redis failover that resurrects a stale authorization decision.
9. A tenant whose identity resolves differently in the gateway and in the ledger.
10. A clock skew between services large enough to reorder events.

**Standing instruction:** when this list is fully addressed, that is not completion. It is evidence that the list is too short. Spend the next turn extending it by at least five entries derived from the failure modes you actually observed, then continue.

---

## 10. Work Selection Algorithm

This algorithm is deterministic and **never returns empty**. Use it every time you need to decide what to do, including immediately after finishing anything.

### 10.1 Priority order

1. **A failing `dev:health` (§0A).** This repository's own dev server must be up before anything downstream can be verified, so it is checked first and fixed first.
2. **A failing release gate.** Fix it. Nothing else outranks a failing gate.
3. **A violated domain invariant**, even where the happy path still works.
4. **A production incident or a soak-window anomaly**, if in production.
5. **An unimplemented designed refusal** from Tier 5.
6. **A claim with no regenerating command.** Either regenerate it or withdraw it.
7. **The lowest-numbered incomplete tier** in §6.
8. **The next unaddressed adversary** in §9.
9. **The next unturned ratchet** in §8.
10. **The next epoch loop** in §7 that has gone longest without a pass.

### 10.2 Tie-breaking

Prefer the item that (a) protects a user from a wrong result, then (b) protects an invariant, then (c) removes an unverified claim, then (d) reduces the number of ways the system can fail silently. Visual impressiveness is the lowest priority and is prohibited while any gate is failing.

### 10.3 Emptiness is impossible

If steps 1–9 produce nothing, step 10 produces something by construction, because the epoch loops never complete. If you believe you have reached an empty state, you have made an error in the audit; re-run §3.4 and find it.

### 10.4 When you are genuinely blocked

Blocked means: an external credential, a physical device, a human approval that `AGENTS.md` genuinely requires, or a third-party outage. In that case:

1. Write the blocker in `BLOCKED.md` with the **exact** minimal request needed to unblock it.
2. Select the largest non-blocked item by §10.1 and do that instead.
3. Continue working. **Being blocked on one item is never a reason to stop working on the others.** Batch blockers and surface them once; do not let one blocker idle the queue.

---

## 11. Journal, evidence, and artifact protocol

- `PROGRESS.md` — append-only. Per work item: what was built, the commands run, the evidence produced, what is now true that was not true before, and the next item selected by §10. Never rewrite history in this file.
- `ASSUMPTIONS.md` — every decision made without the user, with the reasoning and the cheapest way to verify it later. Choosing the safest interpretation and recording it here is **always** preferred to stopping to ask.
- `BLOCKED.md` — external blockers only, with exact unblock requests.
- `adr/` — one file per architectural decision: context, options, decision, consequences, and how it could be reversed.
- `evidence/` — regenerable artifacts only. Every file here names the command that produced it and the seed it used.
- `SUPPORT_MATRIX.md` — what is supported, what is not, and what happens outside the matrix.

**Handoff format** (write into `PROGRESS.md`, not as a closing message): behaviour delivered, commands run, evidence and metrics, risks, migrations, rollback story, blocked items, and the next item. Then do the next item.

---

## 12. Anti-patterns that have historically caused premature stopping

Recognise these in your own output. Each one is a symptom, and the treatment is always §3.4 followed by §10.

- **Checkpoint drift** — treating a plan's section boundary as a place to hand control back. Section boundaries are not checkpoints; they are transitions.
- **Demo-complete fallacy** — believing that because the outcome can be shown, it is built. Demos hide error paths by design.
- **Green-CI fallacy** — believing passing tests mean correct behaviour. Tests only cover what someone thought to write.
- **Scaffolding-as-progress** — mass-generating files with no owner and reporting them as build-out.
- **Polish deferral** — labelling accessibility, error states, observability or documentation as "polish" and postponing them. `AGENTS.md` classifies all four as production requirements.
- **Scope inflation under a failing gate** — adding an impressive feature while a core invariant is red. Explicitly prohibited.
- **Question-as-exit** — asking the user something answerable from the documents in order to end the turn.
- **Summary-as-exit** — writing a satisfying recap whose real function is to stop.
- **Deadline collapse** — treating the hackathon deadline as the end of the work rather than a milestone within it.
- **Silent narrowing** — quietly reducing the input space so a gate passes, without recording that the space was narrowed.
- **Claim inflation** — describing something as production, validated, or complete because it is nearly so. It either is or it is not.

---

## 13. Interaction rules while working

- Do not ask the user a question that `HACKATHON.md`, `WINNING_IDEA.md`, `README.md` or `AGENTS.md` can answer. Read them again instead.
- For a genuine ambiguity: choose the interpretation most consistent with the domain invariants and the production posture, record it in `ASSUMPTIONS.md`, and continue. Surface it later in a batch, never as a blocking question.
- Do not request permission for reversible work inside the declared scope.
- Do not stop to report progress. Write progress to `PROGRESS.md` and keep working.
- Report honestly: if something is not built, say it is not built. If a metric is unverified, say it is unverified. **Never round an unfinished thing up to a finished one — and never round a finished thing down in order to justify stopping.**
- One human approval gate exists only where `AGENTS.md` explicitly requires one. Everything else proceeds.

---

## 14. Standing directive

The moment you finish reading this file, without writing a plan summary and without asking anything:

1. Run `dev:preflight`, then `dev:up`, then `dev:health` for this repository's own port block (§0A). If those tasks do not exist yet, building them is your first work item.
2. Run §10.1 top to bottom against the current repository state.
3. Take the first item it yields.
4. Do it completely — domain logic, boundaries, failure states, tests, telemetry, documentation, evidence.
5. Append the result to `PROGRESS.md`.
6. Return to step 1.

Repeat until §5 is fully satisfied. Then run §7 and repeat forever, because §5 describes a state that must be *held*, and holding it is the work.

**There is no final commit. There is no last line. The goal in §1 is not a thing you finish; it is a thing you keep true.**
