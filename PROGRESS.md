# Progress

> Append-only work journal. Never rewrite or delete an earlier entry; append corrections and subsequent evidence.

## 2026-08-10T07:03:40Z — Tier 0 local PostgreSQL least-privilege repair

### Behaviour delivered

- Replaced the application runtime role as PostgreSQL cluster bootstrap superuser with a distinct local owner boundary. `galuxium_nexus_v2_owner` owns the development database; `galuxium_nexus_v2` is now a non-owning login with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`, no owner-role membership, and a connection limit of 20.
- Kept the owner credential in a second ignored mode-0600 file and never passed it to gateway or reconciler. Provisioning transfers the runtime password through a bounded process environment and a fixed, temporary mode-0600 SQL program; failed command evidence redacts both credential values.
- Strengthened `dev:health` so the PostgreSQL row is green only when database identity, owner, runtime role, exact version/address/port, and every least-privilege flag match. Strengthened PID-reuse defence to require exact `ps lstart` identity, and reverify a newly spawned PID immediately before any cleanup signal after an ownership-record failure.
- Preserved the prior session-created cluster rather than deleting it. After exact owned shutdown it was moved to `.dev/tmp/legacy-superuser-cluster-20260810T070340Z`; a clean least-privilege cluster was then initialised at `.dev/postgres/data`.

### Commands and evidence

- `npm run dev:health` — failed first, as designed, because the old cluster had no `galuxium_nexus_v2_owner`; this converted the live superuser finding into a failing gate rather than accepting it as healthy.
- Pinned Node `24.18.0` / npm `11.16.0`: `vitest run tooling/dev/test/command.test.mjs tooling/dev/test/ownership.test.mjs tooling/dev/test/runtime.test.mjs tooling/dev/test/preflight.test.mjs tooling/dev/test/readiness.test.mjs --maxWorkers=1` — 5 files, 19 tests passed.
- Pinned runtime: `vitest run tooling/dev/test/postgres-readiness.test.mjs tooling/dev/test/command.test.mjs tooling/dev/test/ownership.test.mjs tooling/dev/test/runtime.test.mjs --maxWorkers=1` — 4 files, 19 tests passed, including six explicit PostgreSQL privilege-drift refusals and the never-signal-a-reused-PID case.
- `eslint tooling/dev --max-warnings 0` — exited 0.
- `npm run dev:down` — stopped exactly the seven recorded service PIDs; no broad process or container command was used.
- `lsof -nP -a -iTCP@127.0.0.1:4160-4169 -sTCP:LISTEN` after shutdown — no listener remained in the exclusive block.
- `npm run dev:preflight` — passed with exact toolchain, ignored `.dev/`, the declared port map, and zero listeners.
- `npm run dev:up && npm run dev:health` — started and recorded all seven services under run `daf71930-d320-4d27-8ebf-189ef548adb1`; health passed gateway, reconciler, admin, fake-provider, PostgreSQL 16.14 with `owner=galuxium_nexus_v2_owner role=galuxium_nexus_v2 least_privilege=ok`, Redis 8.8.0 DB 6, and metrics on `127.0.0.1:4160-4169`.

### What is now true

The running application processes no longer connect with PostgreSQL superuser, role-creation, database-creation, replication, or row-security-bypass authority. A privilege regression is a local health failure and a unit-test failure instead of a hidden configuration weakness. This proves only the local development foundation; the repository remains **not yet in production**.

### Risks, migration, rollback, blockers, and next selection

- The local owner remains the repository cluster's bootstrap superuser by PostgreSQL design. Its credential is intentionally unavailable to application processes; production identities, schema grants, migrations, backup, and restore remain future work.
- The legacy cluster remains preserved under ignored `.dev/tmp/` for forensic rollback. Rollback is exact owned shutdown followed by an explicit operator-controlled directory swap; tooling never deletes or silently reuses it. Restoring that cluster would also restore the known insecure role posture and therefore cannot pass current `dev:health`.
- No external blocker is active.
- §10.1 next selects the lowest incomplete tier, Tier 0: freeze the application hardening and verification orchestration, regenerate dependency evidence, rebuild/restart the exact worktree, run canonical `verify-all`, and prove it again from a clean checkout before beginning Tier 1.

## 2026-08-10T10:56:09Z — Tier 0 executable HTTP foundation and canonical verifier

### Behaviour delivered

- Added strict npm workspaces and project references for the gateway, reconciler, ledger, observability, admin, metrics, and deterministic fake-provider ownership slices. Typed environment parsing refuses wrong hosts, ports, service identities, database paths, and Redis namespaces before startup.
- Implemented real loopback liveness/readiness and Prometheus-compatible surfaces, structured bounded redaction, stable safe error responses, request deadlines/cancellation, deterministic fake-provider success and refusal contracts, and a truthful accessible admin status surface. These are local foundation diagnostics; no budget authorization or provider dispatch is represented as implemented.
- Added immutable bootstrap under checksummed Node `24.18.0`/npm `11.16.0`, lifecycle-script denial, strict TypeScript `6.0.3`, zero-warning lint/format/type gates, package/source boundary enforcement with a negative fixture, unit/property versus real integration/E2E separation, exact runtime refresh, and one canonical `verify-all` orchestration used by Make and CI.
- Added pinned Chromium browser setup, keyboard/semantic and axe critical/serious accessibility checks, deterministic integration failure cases, a GitHub Actions workflow with commit-SHA-pinned actions, and exact-source PostgreSQL/Redis provisioning for the Linux runner. The workflow explicitly does not claim bit-reproducible native binaries or production artifacts.

### Commands and evidence

- Pinned runtime targeted source-hardening suites — 57 of 57 tests passed, including malformed request targets, deadline/cancellation, hostile secret files, Redis namespace refusal, bounded PostgreSQL probes, and 1,000 seeded structural-redaction cases.
- `npm run typecheck`, targeted ESLint with zero warnings, and targeted Prettier checks — exited 0 after the source-hardening slice.
- `npm run test:integration` — 24 of 24 real-topology cases passed after correcting the test hook to retain one bounded `dev:health` result instead of running the expensive probe twice.
- `npm run test:e2e` — 2 of 2 Chromium tests passed: keyboard/semantic navigation and zero critical/serious axe violations. A contradictory inherited colour environment was removed at the Playwright boundary, and the repeated run emitted no Node warning.
- `npm run dev:health` repeated three times — every allocated service passed on the exact loopback block under run `e7f8686d-195b-48b9-be1b-a34b2a781172`; gateway/reconciler ledger readiness is bounded at eight concurrent probes so the intentionally cascading admin/metrics topology cannot deny its own healthy check.
- `npm run boundaries` — the private package-to-application negative fixture was rejected by both named ownership rules and the current dependency graph passed.

### What is now true

The repository has an executable, strict, production-shaped local foundation rather than documentation-only placeholders. Every displayed admin dependency state and every health row comes from a real protocol request against an owned process. The supported outcome remains deliberately narrow and **not yet in production**; the monetary domain and all later release gates remain absent.

### Risks, migration, rollback, blockers, and next selection

- A subsequent independent Tier 0 attack found residual PID-identity, lock-takeover, live-log, dependency-response, shutdown, and evidence-portability gaps. Those findings invalidate any interpretation that this work item completed Tier 0; they are being fixed rather than waived.
- The fake provider is a local/test failure boundary only and cannot be used as a real-provider fallback. Removing this slice means exact owned shutdown followed by reverting the workspace/config/source changes; no external state or production data exists.
- No external blocker is active.
- §10.1 next remains Tier 0: close the independent attack findings, make Playwright prove its own `webServer` lifecycle, regenerate dependency evidence from the frozen inputs, then run the canonical verifier from the working tree and a clean checkout.

## 2026-08-10T13:31:59Z — Tier 0 adversarial hardening and dependency-evidence freeze

### Behaviour delivered

- Upgraded the exact local/CI Redis contract from superseded `8.8.0` to `8.10.0`, including the source URL and SHA-256, preflight identity, readiness expectation, CI path, dependency register, and support/assumption records. The exact local binary was upgraded without enabling a shared background service.
- Converted `dev:health` from a single snapshot into bounded, deadline-aware polling of every allocated service followed by an exact listener ownership audit. Direct tests exercise transient-not-ready recovery and deadline exhaustion. PostgreSQL health now repeats the least-privilege checks for application database `CONNECT` only, no `TEMPORARY`, and no `CONNECT` or `TEMPORARY` on `postgres` or `template1`.
- Hardened local secret reads against symlink/parent-redirection, permission, inode, and size races; bounded readiness and artifact downloads while streaming rather than trusting `Content-Length`; sanitized declared secrets from successful and failed command output, rendered arguments, and timeout errors; and added negative tests for each refusal.
- Made external request correlation internal-only, replaced raw URL logging with stable route classes, bounded dependency readiness reads, connection count, in-flight work, request rate, per-socket reuse, shutdown, and lifecycle cleanup. Gateway and reconciler now roll back and close every sibling dependency with idempotent all-settled cleanup when startup or shutdown partially fails.
- Strengthened workspace ownership so an undeclared production import fails even when a root devDependency is hoisted. Added an owned Playwright runner that begins with the topology down, exercises the committed `webServer` startup/teardown path with `reuseExistingServer: false`, audits zero residual listeners/records, and restores the standing topology. Runtime execution of that runner remains intentionally pending the ownership-schema hardening below.
- Froze executable dependency evidence with strict schema validation, discriminated native provenance, path-leak refusals, exact native/browser artifacts, per-direct-dependency review records, and non-mutating byte-stability checks. Current npm full and production audits each reported zero known advisories at the recorded point in time; this does not substitute for the explicitly pending upstream, historical, legal, platform, and runtime-cost reviews.

### Commands and evidence

- Pinned Vitest: PostgreSQL recurring privilege posture `13/13`; readiness/PostgreSQL `13/13`; filesystem/preflight `12/12`; health/filesystem/readiness/command `16/16`; bounded-download `7/7`; dependency schema/path suite `11/11` — all passed serially.
- `tsc -b packages/observability apps/admin services/metrics services/gateway services/reconciler --pretty false` — exited 0. The observability suite passed `86/86`, including streaming caps, hostile log markers, overload/rate refusal, connection drops, active-request abort, and forced close. Targeted strict ESLint and Prettier checks passed with zero warnings.
- `npm run boundaries` — rejected both the private cross-workspace fixture and the root-hoisted undeclared-import fixture; the current graph passed with 82 modules and 211 dependencies.
- `npm run dependencies:verify` generated evidence for 22 unique direct dependencies, 31 declarations, and 259 exact lock entries; both audit scopes were zero at `2026-08-10T11:23:54.451Z`. A subsequent non-mutating `dependencies:check` passed at `2026-08-10T11:31:21.651Z`; all four evidence hashes, sizes, and mtimes remained byte-identical and the recursive absolute-home/worktree-path refusal passed.
- Final evidence SHA-256 values: dependency metadata `c7a674c68f9cbb659caa03b1f4da026ae400fd646ac14301fa33dcfc37e99d8b`; full audit `974edda2104e58597ede85c766f82e2c7b0b4615222b4efd9972254e090b427a`; production audit `94cfe8b8e81897e51658c169ea729ccdfe00071b820f1a8a604b472004413d35`; verification `c398623ae5f129cd1a7277a3ea1cd03bda26353c5f68ba5a5ab63077d4f897d1`.

### What is now true

The current source and dependency foundation fails closed across the independently identified request, log, secret, download, workspace-import, readiness, and dependency-evidence gaps. Those results are static and unit-level evidence only where stated. The old ownership-record topology was stopped exactly before the incompatible lifecycle migration, so `dev:health` is deliberately not green at this journal point. The repository remains **not yet in production**.

### Risks, migration, rollback, blockers, and next selection

- Local process ownership and log-supervision records are being upgraded incompatibly; claiming current runtime health before that migration is built, tested, restarted, and audited would be false. The runtime is intentionally down, with no foreign process signalled.
- The Playwright-owned runner has not yet been exercised against the new lifecycle implementation. Dependency audit results are point-in-time npm observations and the register intentionally leaves broader release-admission reviews pending.
- Rollback is source-only until runtime restart: revert the affected source/config files while leaving ignored local data untouched. The Redis version pin must never be rolled back independently of its provenance/evidence files.
- No external blocker is active.
- §10.1 next remains Tier 0: finish and attack the exact-PID lifecycle/log supervisor, rebuild and restart the owned topology, run integration and the Playwright-owned path, then run canonical and clean-checkout verification plus CI before advancing immediately to Tier 1.

## 2026-08-10T15:29:57Z — Current-state audit and next-agent execution queue

### Audit scope and status decision

- Audited commit `e5d5297729b65a17931aa8d8307146a5d84a8baa`, every tracked workspace and test surface, the command orchestration, dependency evidence, both ADRs, the support matrix, and GitHub Actions run `31402709073` against the Tier 0–13 ladder and six release gates in `GOAL.md`.
- Corrected stale documentation that still said implementation had not started, documented the actual executable surfaces and absent product behavior, replaced the planned tree with the checked-in tree, and linked all status readers back to this append-only journal.
- **Current decision:** the lowest incomplete tier is still **Tier 0**. The local topology is operational, but the canonical verifier and CI are red. Tier 1 monetary-domain implementation must not begin until the failing Tier 0 gates below are fixed and re-run from a clean checkout.
- The repository remains **not yet in production**. There is no production deployment, real provider authorization, real spend, production credential, real-user result, backup/restore drill, rollback drill, or soak evidence.

### What is verifiably present

- Exact Node.js `24.18.0`, npm `11.16.0`, and TypeScript `6.0.3` pins; immutable `npm ci --ignore-scripts` bootstrap; strict compiler settings; a committed lockfile; runtime-schema validation; and build-failing workspace/import boundaries.
- Repository-owned local lifecycle for gateway, reconciler, admin, fake provider, PostgreSQL `16.14`, Redis `8.10.0` DB 6, and metrics, all confined to `127.0.0.1:4160–4169` and ignored `.dev/` state.
- Dependency-backed liveness/readiness, least-privilege local PostgreSQL identity checks, structured bounded logs and redaction, Prometheus-compatible foundation metrics, bounded HTTP request handling, and deterministic local/test provider failure modes.
- An accessible admin dependency-status page that explicitly says budget and ledger workflows are absent. It is diagnostics only, not the canonical product workflow.
- `make test` passed all **30 test files and 213 tests** in this audit.
- `make dev-health` passed all seven allocated services after the failure-path runs, including PostgreSQL owner/runtime privilege checks and Redis version/DB identity.

### End-goal progress by ladder tier

| Tier | Current state | Evidence in the repository | Required before advancing |
|---:|---|---|---|
| 0 — executable foundation | **In progress; red** | Pinned workspace, bootstrap, local lifecycle, CI workflow, ADRs, dependency register/evidence, unit/integration/E2E foundations | Fix every current failure below; run `make verify-all` from the frozen working tree and a clean checkout; obtain green Linux CI; close the Tier 0 dependency-review claims |
| 1 — encoded invariants | **Not started** | Eight invariants exist in prose only; `packages/ledger` exports PostgreSQL health checks, not monetary types or transitions | Encode every invariant in domain types/schema/boundary assertions and attack each with named seeded property/fault tests |
| 2 — hard technical core | **Not started** | PostgreSQL connectivity exists; no monetary tables or algorithms exist | Build the double-entry ledger, versioned worst-case quote, atomic reservation, fenced/idempotent settlement/release, unknown-outcome retention, reconciler, RLS, and linearizability oracle; run the reservation-tightness kill test |
| 3 — adapters and trust boundaries | **Foundation only** | Runtime configuration schemas and a deterministic fake-provider test boundary exist | Add a versioned real-provider adapter, validated external contracts/fixtures, provenance, complete limits, and boundary threat analyses; never make the fake provider a production fallback |
| 4 — first vertical slice | **Not started** | Health/status workflow only | Deliver authenticated quote → reserve → fenced provider call → exact settlement/release → authoritative ledger view, including failure, cancellation, telemetry, migration, and E2E evidence |
| 5 — honest refusal | **Product refusals not started** | Generic HTTP/config/size/deadline refusals exist | Implement and test unknown-price denial, ambiguous-outcome reservation hold, imbalance fail-closed behavior, and unresolved-tenant denial with designed UI states |
| 6 — ownership areas | **Partial foundations** | Foundation code exists for gateway, reconciler, ledger health, observability, admin, and local metrics; `packages/pricing` and `packages/adapters` do not exist | Build each production responsibility completely with ADR, tests, telemetry, and failure states; add missing packages only with working vertical code |
| 7 — verification lattice | **Partial and red** | Unit/property-shaped foundation tests, real local integration tests, and Chromium/axe tests exist | Make current gates green; then add domain unit/property, real database/provider contract, full E2E recovery, security/privacy, accessibility, performance, failover, and chaos coverage |
| 8 — evaluation and evidence | **Unavailable** | Dependency evidence is regenerable; `make eval` intentionally exits non-zero | Commit the domain evaluation manifest/oracles/seeds and regenerate every product or benchmark claim |
| 9 — performance and chaos | **Not started** | Bounded foundation operations are tested, but no product budgets or chaos matrix exist | Declare and enforce latency/resource/cost budgets; load to failure; inject every required crash, partition, duplicate, delay, and exhaustion case |
| 10 — security/privacy/supply chain | **Partial foundation** | Redaction tests, least-privilege local DB role, exact pins, current dependency evidence | Add authentication, scoped keys, tenant RLS/authorization, immutable audit, kill switches, full threat model, historical/legal dependency disposition, SBOM, and release manifest |
| 11 — operations | **Partial local diagnostics** | Typed local config, liveness/readiness, local logs, and metrics | Add production SLOs/alerts/runbooks/traces/dashboards, migrations, backups/restore, deployment/rollback, emergency disable, retention/cleanup, and incident process |
| 12 — production | **Not started** | None; loopback is not production evidence | Deploy a tagged CI artifact, exercise real capped spend, complete every production criterion, real-user test, soak, incident, upgrade, rollback, and restore drill |
| 13 — submission | **Draft exists; release artifact absent** | Hackathon dossier records draft id `1131632`; the concept is selected | User-approved product name/pitch/assets, public deployment/repo, accurate built-with list, screenshots, 2–5 minute public video, disclosures, claim audit, and final submission before the deadline |

### Current failing gates — fix these before feature work

1. **Canonical local verification is red.** `make verify-all` stops in `npm run format:check` because `tooling/dev/preflight.mjs` is not Prettier-clean. No later canonical stage ran in that invocation.
2. **Integration is red.** `make test-integration` rebuilt and health-checked the topology, then passed 23 of 24 cases. `correlation IDs > logs only the internal correlation ID and stable route class for a new request` timed out waiting for the new gateway log record at `tests/integration/foundation-topology.test.ts:302`. Treat this as a real log-delivery/observation defect unless evidence proves the assertion invalid; do not mark it flaky.
3. **Owned Playwright lifecycle is red.** The two browser assertions passed, but `make test-e2e` failed after Playwright because teardown left seven listeners and seven verified ownership records. The wrapper restored a healthy standing topology, but recovery does not satisfy the required proof that Playwright tore down what its `webServer` command started.
4. **Linux CI is red.** [GitHub Actions run 31402709073](https://github.com/rishabhcli/galuxium-nexus-v2/actions/runs/31402709073) failed in `Build exact-version native tools from SHA-256-verified source`: the Redis `8.10.0` build attempted the bundled modules, RedisSearch produced no `.so`, and `make build` exited 2. Bootstrap and the canonical verifier never ran on Linux.
5. **Clean-checkout verification has no passing evidence.** A working-tree health result and passing isolated tests cannot substitute for it.

### Six release gates

| Gate | Status | Missing proof |
|---|---|---|
| G1 zero over-authorization under concurrency | **Unavailable** | No monetary reservation path or linearizability suite |
| G2 balanced ledger under property/chaos tests | **Unavailable** | No ledger schema/state machine or accounting property/chaos suite |
| G3 audited unknown outcomes/manual adjustment | **Unavailable** | No attempts, reconciliation, adjustments, or audit ledger |
| G4 tenant isolation/security review | **Unavailable** | No product auth, scoped keys, tenant data, RLS policy, or authorization matrix |
| G5 SLOs/alerts/runbooks/backups/restore | **Unavailable** | No production operational stack or drill evidence |
| G6 admin equals authoritative ledger | **Unavailable** | No monetary ledger API or product admin view |

`make release-check` correctly exits unavailable. Do not change it to green until all six gates and the common release requirements are implemented and regenerable.

### Exact next-agent queue

1. Re-run `make dev-health`; if red, restore the owned topology before anything else.
2. Fix the tracked Prettier failure and confirm `npm run format:check` without broad unrelated formatting.
3. Reproduce and repair the gateway log-observation failure. Verify whether the supervisor flush/watch contract or the test's bounded observation mechanism is wrong, then retain a deterministic failure-path test.
4. Repair Playwright `webServer` ownership propagation/teardown so the test-started topology reaches zero listeners and zero ownership records before the standing topology is restored.
5. Repair the Linux Redis provisioner. Build and install only the exact server/client artifacts the runtime contract admits, or make the declared module build reproducible; update provenance and dependency evidence with whichever boundary is selected. Do not ignore a failed bundled module while claiming the whole build succeeded.
6. Run `make verify-all` on the frozen tree. Then reproduce from a clean checkout and push until GitHub Actions is green with no repository mutation.
7. Close remaining Tier 0 dependency admission fields in `docs/DEPENDENCIES.md` and its machine register: upstream/maintenance, historical security, legal obligations, platform support, signatures/provenance, failure behavior, and measured applicable costs.
8. Only then begin Tier 1. Start with explicit money units, tenant/account/reservation identifiers, versioned quote provenance, and a reservation tagged union/state-machine specification; add seeded property tests for all eight invariants before feature endpoints or dashboard work.

### Commands and evidence from this audit

- `make dev-preflight && make dev-up && make dev-health` — passed; reused a verified repository-owned runtime and confirmed all seven services.
- `make verify-all` — failed at `format:check` on `tooling/dev/preflight.mjs`.
- `make test` — 30 files and 213 tests passed.
- `make test-integration` — 23 passed, 1 failed at the gateway log observation described above.
- `make test-e2e` — both Chromium tests passed; the enclosing ownership/teardown gate failed with seven residual listeners and records; standing topology recovery passed.
- Final `make dev-health` — passed every allocated service after the failed integration/E2E runs.
- `gh run view 31402709073 --log-failed` — confirmed the Linux RedisSearch build failure before bootstrap.

### Risks, migration, rollback, and blockers

- No product schema or persistent production data exists, so this documentation change needs no data migration. Rollback is a source/documentation revert.
- The healthy local topology can create false confidence: gateway and reconciler return `FOUNDATION_ONLY`, the ledger package performs health probes only, and the admin page has no monetary state.
- The dependency evidence contains point-in-time advisory observations, not complete historical security or legal admission.
- No external blocker is active; the four red gates are repository defects and remain in this journal rather than `BLOCKED.md`.

## 2026-08-10T19:26:24Z — Streaming log redactor withheld every newest record (integration gate repaired)

> Two agent sessions are working this tree concurrently on `main`. This entry covers only
> `tooling/dev/log-supervisor.mjs` and `tooling/dev/test/log-supervisor.test.mjs`. The concurrent
> session owns `tooling/dev/preflight.mjs`, `tooling/dev/test/preflight.test.mjs`,
> `tooling/run-playwright-owned.mjs`, `tooling/dev/{e2e-server,ownership,up,down,listeners}.mjs`,
> `tooling/ci/**`, `playwright.config.ts`, and `.github/workflows/**`. Agreed shared-tree rules:
> explicit-path `git add` only, no `checkout`/`switch`/`restore`/`stash`/`reset`/`clean` on this
> tree (clean-checkout verification uses `git worktree add` under ignored `.dev/tmp/`), and announce
> every `dev:down`/`dev:up` cycle before running it.

### Behaviour delivered

- Fixed the root cause of failing gate 2 recorded in the previous entry. `createStreamingRedactor`
  withheld a **fixed-width** tail of `longestSecretLength - 1` characters from every supervised
  service log for as long as no further output arrived. Both local secrets are 43 characters, so the
  last 42 characters of every log were permanently buffered and the newest complete record was
  structurally unobservable. Before the fix, `.dev/logs/gateway.log` ended mid-UUID at
  `"requestId":"157acf93-313f-467b-8c26-2c8e9d69d5`; after it, the file ends with a complete record
  and a newline.
- Replaced the fixed-width tail with `withheldSuffixLength`, which withholds only the maximal suffix
  that is a **proper prefix of some redaction value**. Output that cannot extend into a secret — for
  example `,"status":200}}\n` — is emitted immediately, while a genuine partial match is still held
  until it resolves. Retaining the *longest* extendable suffix is what preserves the redaction
  guarantee: any secret occurrence straddling an emit boundary must begin inside that suffix.
- This was never a flaky test and never an invalid assertion. `tests/integration/foundation-topology.test.ts:302`
  was correct and was reporting a real log-delivery defect, so no test was weakened, quarantined, or
  marked flaky. That file is unchanged.

### Commands and evidence

- Pinned Node `24.18.0`: `vitest run tooling/dev/test/log-supervisor.test.mjs --maxWorkers=1` —
  12/12 passed, including the new regression case, the partial-prefix boundary case, and a
  600-case seeded `fast-check` property (seed `20260810`) asserting that no emitted chunk ever
  contains the secret, that streamed output plus flush equals the fully redacted source, and that
  the withheld amount is exactly the live partial match.
- `make test-integration` — rebuilt, cycled the owned topology under run
  `7afaa822-9e69-4db4-8c1e-092d4b59fd32`, and passed **24 of 24** integration cases. The previously
  failing `logs only the internal correlation ID and stable route class for a new request` now passes.
- `make test` — 30 files, 238 tests passed. (Count includes the concurrent session's uncommitted
  preflight tests; only the 12 log-supervisor tests are evidence for this entry.)
- Targeted `prettier --check` and `eslint --max-warnings 0` on both changed files — exited 0.
- `tail -2 .dev/logs/gateway.log` plus `tail -c 1 | od -c` — the live log now ends with a complete
  JSON record terminated by `\n`.

### What is now true

Supervised service logs are observable up to the last byte that cannot be part of a secret, so a
log-derived assertion can now see the record it just caused. Any `dev:health` result or log-derived
assertion recorded **before** this fix must not be treated as evidence, because the tail those runs
read was structurally incomplete.

### Risks, migration, rollback, blockers, and next selection

- The fix only applies to supervisors started after it, so every log written by an older supervisor
  still has a truncated tail. A `dev:down`/`dev:up` cycle is required before trusting log-derived
  assertions; the cycle above already did this.
- `withheldSuffixLength` scans at most `longestSecret - 1` suffix lengths per chunk against at most
  8 redaction values. With 43-character secrets that is bounded and cheap; the comparison exits at
  the first differing character in the common case. No unbounded buffer was introduced — the pending
  buffer is now strictly smaller than before.
- Rollback is a source-only revert of these two files. No persistent state or schema is involved.
- No external blocker is active. Remaining Tier 0 red gates (Playwright `webServer` teardown, Linux
  Redis provisioner, canonical and clean-checkout `verify-all`, dependency admission fields) are
  owned by the concurrent session.
- §10.1 next for this session: the lowest incomplete tier reachable without touching the other
  session's files — **Tier 1**, encoding the eight domain invariants in `packages/ledger` and
  `packages/pricing` as money types, schema constraints, and a reservation state machine, each
  attacked by a named seeded property test with a stated case count.

## 2026-08-10T20:20:00Z — Tier 0 red-gate queue: CI native provisioning, dependency evidence, Playwright teardown proof

Concurrent-session note: two agent sessions are working this one repository and working tree at
the same time. Work was split by file ownership and both sessions agreed to explicit-path commits
only, no `git checkout`/`restore`/`stash`/`reset`/`clean` on the shared tree, clean-checkout
verification via `git worktree`, and advance notice before cycling the shared 4160-4169 topology.
This session owns `tooling/ci/**`, `tooling/dependencies/**`, `tooling/dev/{down,up,e2e-server,
preflight,ownership,listeners}.mjs`, `tooling/run-playwright-owned.mjs`, `playwright.config.ts`,
`.github/workflows/**` and those files' tests.

### Behaviour delivered

- **Linux CI native provisioning (queue item 5, was red).** Redis 8.10.0's default make goal routes
  through `scripts/build.sh`, which builds Redis core and then every module bundled under
  `modules/*/src`. RedisSearch needs a Rust toolchain this job deliberately does not provision, so
  it produced no `.so` and `make build` exited 2 roughly six minutes in, before bootstrap ever ran.
  Confirmed from the failed run's own log: `ERROR: make build finished with module failure(s):
  redisearch` / `make: *** [Makefile:109: build] Error 1`, after redisbloom, rejson and
  redistimeseries had built successfully. Now builds only the two binaries the runtime contract
  admits, and asserts that boundary structurally instead of inheriting it from the make invocation.
- **Preflight version-pin escaping.** The PostgreSQL patterns escaped only the first dot via
  `String.replace`, so a version carrying two dots would leave the second unescaped and match any
  character there, admitting a foreign build. Replaced with total metacharacter escaping.
- **Dependency evidence (queue item 7, partial).** The evidence fingerprint covers the CI
  provisioner and its toolchain register, so changing them correctly staled it. Regenerated from
  frozen inputs rather than relaxing the check, and added the provisioned-surface refusal tests to
  the fingerprinted input set so weakening a refusal stales the evidence instead of passing.
- **Playwright webServer ownership and teardown (queue item 4, was red).** Three separate defects:
  the webServer ran through an `npm run` shim so Playwright's SIGTERM never reached the process
  that owns the topology; the teardown assertion sampled listener and record counts once,
  immediately after Playwright returned, which is a race and cannot distinguish a torn-down
  topology from a webServer that never started; and `waitForVerifiedExit` in `dev:down` treated
  every non-`not-running` ownership reason as a hard error even though each one proves the recorded
  process exited. All three fixed; details and the invalid-test removal rationale are in commit
  `a62f4fa`.

### Commands run and evidence emitted

- `make dev-health` — passed all seven allocated services on `127.0.0.1:4160-4169`.
- Redis build boundary verified against the real archive: downloaded
  `redis-8.10.0.tar.gz`, whose SHA-256 `f1baa4b28befd417aa6577ebeedde9e9fc7814cfcc299b2a6d2fd99ef7420a6c`
  matches the committed pin byte-for-byte; `make -C src BUILD_TLS=no MALLOC=libc redis-server
  redis-cli` linked both binaries in 21s; they report `Redis server v=8.10.0` and
  `redis-cli 8.10.0`; `find` showed zero `.so` outside `deps/`.
- `make test-e2e` — **exits 0**. Log records the full ownership chain: `[dev:e2e-server] READY
  run=02e07a22-42c6-4806-8373-fa86ea2856d8 ownership=started-here`, both Chromium tests passing,
  `[dev:e2e-server] stopping reason=SIGTERM`, `[dev:e2e-server] PASS stopped the topology it
  started.`, `[playwright-owned] PASS Playwright started and stopped its exact repository-owned
  webServer topology run=02e07a22-42c6-4806-8373-fa86ea2856d8` (the same run id it started), and
  the standing topology restored as `run=e3c751be-b55d-4c9d-be0d-634acf844f63`.
- Full unit/property suite — 39 files, 337 tests passing, including the concurrent session's Tier 1
  reservation property tests at 2000 cases each.
- `npm run dependencies:verify` then `--check` — 22 unique direct dependencies across 31
  declarations; both npm audit scopes observed 0 known vulnerabilities at 2026-08-10T20:05:47.309Z;
  the non-mutating recheck confirmed inputs and digests match.
- `npm run boundaries` — 119 modules, 329 dependencies, no violations, negative fixtures rejected.
- New refusal tests: `tooling/test/provisioned-native-surface.test.mjs` (9),
  `tooling/test/playwright-teardown-proof.test.mjs` (7), plus a 2000-case seeded property test
  (seed 20260810) asserting an anchored escaped version literal matches exactly itself.
- Clean-checkout worktree created at the pushed commit for verification independent of either
  session's uncommitted work.

### What is now true that was not true before

Linux CI gets past native provisioning and bootstrap for the first time: on run 31427377322 the
`Build exact-version native tools from SHA-256-verified source`, `Bootstrap through make` and
Chromium-deps steps are all green, and from a clean checkout on Linux `toolchain:check`,
`format:check`, `lint`, `typecheck`, `boundaries` (103 modules, 276 dependencies) and
`dependencies:check` all pass. The Playwright gate now proves ownership rather than sampling it,
and `dev:down` no longer reports a successful shutdown as a failure.

### Still red / not verified

- The full canonical verifier has **not** yet passed on Linux. Run 31427377322 reached `test` and
  failed 5 of 244 tests in `tooling/dev/test/ownership.test.mjs`, Linux-only, from a mock gap that
  commit `a62f4fa` fixes. That fix is pushed but not yet confirmed by a Linux run.
- `make verify-all` has not passed end to end locally either, because `format:check` currently
  fails on the other session's uncommitted `packages/ledger` files. Not this session's files.
- No clean-checkout `verify-all` pass has been recorded yet. The worktree exists and is bootstrapped
  but has not produced a green run.
- Every §6 release gate G1-G6 remains **unavailable**: there is still no monetary reservation path,
  ledger schema, tenant authorization, operational stack, or admin ledger view. The repository is
  **not yet in production** and no §5 clause is satisfied.

### §10.1 next selected

A failing release gate outranks tier work, and the canonical verifier is still red on Linux, so:
confirm the ownership fix on ubuntu-24.04, then get `verify-all` green from the clean-checkout
worktree, then close the remaining Tier 0 dependency admission fields in `docs/DEPENDENCIES.md`
and its machine register.

## 2026-08-10T20:21:20Z — Tier 1: the eight domain invariants encoded in types, refusals, and seeded properties

> Concurrent-session note: this entry covers only `packages/ledger/**`, `SUPPORT_MATRIX.md`, and
> `ASSUMPTIONS.md`. The other session owns the Tier 0 lifecycle, CI, and Playwright surfaces and has
> its own entries. No file outside this set was touched.

### Behaviour delivered

`packages/ledger` stops being a health probe and becomes the monetary domain. Seven new modules, all
pure and dependency-free apart from the already-admitted `pg` driver.

- **`src/money.ts`** — money as an integer count of nanodollars (1e-9 USD) in `bigint`, bounded to
  ±1e24, with a canonical decimal-integer wire form. No `number` path exists into or out of an
  amount, so binary floating point is structurally excluded rather than merely avoided. Three
  branded tiers — signed, non-negative, strictly positive — so a ledger entry cannot be constructed
  from an amount that was never proven positive. `ceilingDivideNanodollars` is the only division,
  and it rounds up, because a quote must upper-bound a cost that is unknowable until the provider
  call finishes.
- **`src/tokens.ts`** — token counts as a bounded type admitted from `unknown`, since all three
  sources (a client's `max_tokens`, a provider's reported usage, this system's own forwarded count)
  are untrusted and lie differently.
- **`src/time.ts`** — instants as microseconds since the epoch in `bigint`, matching PostgreSQL
  `timestamptz` resolution exactly. A non-`Z` offset is refused rather than converted, and
  `Date.UTC` normalisation is caught by comparing the parsed fields back out, so `2026-02-30` is
  refused instead of silently stored as March 2nd.
- **`src/identity.ts`** — **I7**. `TenantScope` is opaque and constructible only by validating a
  tenant identifier, so a ledger operation cannot be *expressed* without a scope. Identifiers this
  system mints are a different type from a caller-supplied idempotency key. Uppercase UUIDs are
  refused rather than normalised, because normalising lets one row be addressed by two strings and
  defeats any uniqueness constraint over the text form.
- **`src/reservation.ts`** — **I1, I3, I4, I6** and fencing. Six states: `open`, `dispatched`,
  `uncertain`, and the terminal `settled`, `released`, `adjusted`. `applyReservationEvent` is total
  over states × events with no default case, split into per-status handlers each switching
  exhaustively, so adding a state or an event fails to compile until its behaviour is decided.
- **`src/admission.ts`** — the runtime half of **I1**. A `DispatchAuthorization` makes an
  unauthorized provider call fail to compile, and that defence is erased at runtime, so
  `admitProviderDispatch` re-establishes the same fact against the authoritative record: correct
  shape, persisted state is `dispatched`, current fencing token, matching identity, matching price
  version, matching amount, owning scope. Seven stable refusal codes.
- **`src/cache.ts`** — **I8** as a type that cannot express the forbidden outcome. `CacheAdvice` has
  a `deny` variant and an `unknown` variant and no allow variant, so no cache read can authorize
  money. Every failure mode — miss, stale, unavailable, unparseable — maps to `unknown`, which sends
  the caller to PostgreSQL rather than past it.

Two design decisions worth naming because they resolve real conflicts rather than picking a style:

1. **Expiry of a dispatched attempt holds instead of releasing.** `WINNING_IDEA.md` describes a
   reaper releasing orphans; I6 requires an unknown outcome to stay reserved. Those conflict for
   exactly one case — a reservation whose provider call may have started. Splitting `dispatched`
   from `open` resolves it toward the side that cannot leak money.
2. **The ceiling bounds authorization, not realized spend.** Provider usage arriving after a
   reservation resolved posts a `compensate_unreconciled_overspend` movement to a dedicated account
   rather than debiting available balance, so a tenant's *recorded spend* can exceed its ceiling
   while every *authorization* stayed within it. Discarding the usage would hide real money;
   debiting balance would drive a tenant negative and violate I2. Now documented under "Scope of the
   spend guarantee" in `SUPPORT_MATRIX.md`, with the requirement that no surface renders a tenant
   carrying a residual as "within cap". Raised by the concurrent session during review; it was right
   to insist the limitation be published before the claim audit rather than after.

### Invariant encoding map — Tier 1 evidence

| Invariant | Encoded at | Attacked by | Cases |
|---|---|---|---|
| I1 no call without a committed reservation | `src/reservation.ts` `DispatchAuthorization` + `applyToOpen`; `src/admission.ts` `admitProviderDispatch` | `reservation.test.ts` "returns a dispatch authorization only from a committed open reservation"; `admission.test.ts` "refuses a dispatch against a reservation in any non-dispatched state", "refuses every malformed candidate a non-type-checked caller can send" | 2,000 + 1,000 |
| I2 budget never negative | `src/money.ts` `nonNegativeNanodollars`, bound assertions; `settle` refusing settlement above reservation | `money.test.ts` "never silently produces an amount outside the supported magnitude"; `reservation.test.ts` "refuses a settlement larger than the reservation" | 1,000 |
| I3 exactly one terminal state | `src/reservation.ts` `TERMINAL_RESERVATION_STATUSES`, `applyToTerminal` | `reservation.test.ts` "never leaves a terminal status once entered", "never moves a terminal reservation to a different status" | 2,000 each |
| I4 settlement and release idempotent and balanced | `src/reservation.ts` `settle` computing the released remainder; `repeatsTerminalState` | `reservation.test.ts` "partitions the reserved amount exactly", "emits movements totalling the reserved amount once terminal", "treats an exact repeat of the terminal event as a no-op" | 2,000 each |
| I5 pricing version retained with the attempt | `ReservationHold.priceBookVersion` carried into every terminal state; `admission.ts` version-mismatch refusal | `admission.test.ts` "refuses a price book version that disagrees with the record"; `identity.test.ts` price-book-version admission | 1,000 |
| I6 unknown outcome stays reserved | `src/reservation.ts` `dispatched`/`uncertain` split; `applyToDispatched` expiry path | `reservation.test.ts` "holds the entire reservation while dispatched or uncertain", "turns expiry of a dispatched attempt into a held uncertainty" | 2,000 |
| I7 tenant scoping at every layer | `src/identity.ts` `TenantScope`, `assertWithinScope`; `admission.ts` two-sided scope check | `identity.test.ts` "refuses every cross-tenant pairing"; `admission.test.ts` "refuses a cross-tenant dispatch from either side" | 1,000 |
| I8 caches may deny, never authorize | `src/cache.ts` `CacheAdvice` with no allow variant | `cache.test.ts` "has no vocabulary for allowing anything", "treats an unavailable cache as unknown, never as permission" | 1,000 |

Remaining Tier 1 obligations, deliberately not claimed here: the schema/database-constraint half of
each encoding, the fault-injection scenario per invariant, and the alert-plus-runbook mapping. Those
are Tier 2, Tier 9, and Tier 11 respectively and are not yet started.

### Commands and evidence

- Pinned Node `24.18.0`: `vitest run packages/ledger/test --maxWorkers=1` — 8 files, **81 tests**
  passed, seed `20260810` throughout.
- `vitest run --exclude='tests/integration/**'` — **39 files, 337 tests** passed on the shared tree,
  including the other session's Tier 0 suites.
- `tsc -b packages/ledger --pretty false` — exited 0 under strict settings. TypeScript proved the
  event switches exhaustive: the initial trailing `break`/catch-all statements were reported as
  TS7027 unreachable code and removed, and the per-status handlers keep exhaustiveness enforced by
  `noImplicitReturns`.
- `eslint packages/ledger --max-warnings 0` — exited 0. Reaching that required rewriting every
  refusal assertion rather than configuring the rule away: `vitest/expect-expect` and
  `vitest/no-conditional-expect` were both firing because assertions lived inside helper functions
  and inside property-test branches. Both are legitimate — a conditional `expect` can stop running
  silently — so the tests now convert each outcome into a comparable value via
  `test/support/outcome.ts` and compare one whole result against one whole expectation
  unconditionally. No lint rule was relaxed and no test was weakened.
- `prettier --check .` — clean repository-wide.
- One test constant was wrong and the implementation was right: the epoch microseconds for
  `2026-08-10T12:34:56.654321Z`. Corrected against the system clock
  (`date -u -j -f %Y-%m-%dT%H:%M:%SZ ... +%s` → `1786365296`), not against the module under test.

### What is now true

Six of the eight invariants are now defended by something stronger than a test: I1 by a capability
type plus a boundary assertion, I3 and I4 by a total transition function that computes the released
remainder itself, I5 by a field no terminal state can drop, I7 by a scope that cannot be omitted,
and I8 by a union with no permissive variant. I2 and I6 are defended by refusals plus seeded
properties pending their database constraints. The monetary domain is pure and has no persistence,
no transport, and no service dependency, so none of it is yet exercised against PostgreSQL. The
repository remains **not yet in production**.

### Risks, migration, rollback, blockers, and next selection

- These types are not yet persisted, so no migration exists and rollback is a source-only revert of
  `packages/ledger/**`. `packages/ledger/src/index.ts` gained exports and changed none, so the three
  existing health-probe consumers compile identically.
- The largest open risk is the one `WINNING_IDEA.md` names as the riskiest assumption and it is
  still untested: whether the worst-case bound is tight enough to be usable. Ceiling division and a
  per-budget `max_tokens` ceiling are the intended mitigations, and the overshoot experiment is a
  Tier 2 kill test, not a Tier 1 deliverable.
- Mocked-`fs` suites can pass on macOS and fail on Linux, per the other session's CI finding. Every
  suite added here is pure computation with no filesystem, process, or clock dependency, so it
  carries no platform-specific risk.
- No external blocker is active.
- §10.1 next for this session: Tier 2's hard core, beginning with the double-entry schema and its
  migration — accounts, reservations, attempts, ledger entries as single rows carrying both a debit
  and a credit account so an unbalanced entry is unrepresentable, composite tenant-scoped foreign
  keys, the `CHECK` asserting the same nanodollar bound the domain asserts, and the conditional
  single-statement debit. That work needs live PostgreSQL on 4165 and will be coordinated with the
  other session before it runs.

## 2026-08-10T20:26:00Z — Canonical verifier green from a clean checkout on Linux CI

### What changed in verifiable state

Every one of the five red gates recorded in the 2026-08-10T15:29:57Z audit is now green, verified
from a **clean checkout** on the Linux runner out of a pushed commit rather than from a working
tree. [GitHub Actions run 31428413658](https://github.com/rishabhcli/galuxium-nexus-v2/actions/runs/31428413658)
at commit `8c2a8ab` succeeded on every step, including the two that had never passed:

- `Build exact-version native tools from SHA-256-verified source` — was failing at
  `ERROR: make build finished with module failure(s): redisearch`.
- `Run the canonical full verifier` — `[verify-all] PASS Tier 0 static, unit/property, build,
  runtime health, integration, and browser accessibility gates.`
- `Assert verification did not rewrite or add repository files` — so the verifier is non-mutating.

Verifier stage output from that run:

| Stage | Result |
|---|---|
| `toolchain:check` | pass |
| `check` (format, lint, typecheck, boundaries, dependencies) | pass |
| `test` | 32 files, 261 tests passed |
| `build` | pass |
| `test:integration` | 24 tests passed |
| `test:e2e` | 2 passed; `[playwright-owned] PASS Playwright started and stopped its exact repository-owned webServer topology run=873f40f5-a7ec-40ad-8aa2-8d784172f932` |
| `dev:health` | `PASS local development topology is ready on 127.0.0.1:4160-4169` |

The Playwright ownership proof therefore holds on Linux as well as macOS, on a different PID
allocation regime than the one the original race was found on.

Independently, the same commit tree was verified from a **local clean-checkout `git worktree`** for
the port-free gates: `toolchain:check`, `check`, `test` (32 files, 261 tests) and `build` all
passed there with no repository mutation. Runtime gates were not re-run locally because the shared
4160-4169 block was handed to the concurrent session for its Tier 2 PostgreSQL constraint work.

### Correction to the previous entry

The previous entry listed "no clean-checkout `verify-all` pass has been recorded yet" and the
Linux-only ownership test failure as open. Both are now closed by the run above. The
`format:check` failure noted there was the concurrent session's uncommitted `packages/ledger`
files; that session has since committed them (`babbe0f`) and `prettier --check .` is clean
repository-wide.

### Known gap recorded rather than fixed

`loadVerifiedOwnershipRecords({removeStale:true})` and the pre-signal check in `stopOwnedServices`
still treat only `not-running` as a stale ownership record. Any other drift reason throws, so a
record whose PID was reused by an unrelated process wedges `dev:up` and `dev:down` until the
`.dev/pids/<service>.{pid,meta.json}` files are removed by hand. The `waitForVerifiedExit` fix
removed the path that created drifted records during normal shutdown, so the remaining exposure is
drift arising while no shutdown runs — a crash, or a machine-wide PID wrap. Auto-deleting on drift
is deliberately not done: safe recovery has to distinguish "nothing is listening, so self-heal"
from "something else holds our port, so refuse", and `listeners.mjs` imports `ownership.mjs`, so
that check cannot live inside the ownership module without an import cycle. Fail-closed is the
safer posture and its diagnosis names the exact PID and reason, so it stands, with the ergonomic
cost recorded here rather than discovered later.

### Status of the actual goal

Tier 0's executable contract is now green and reproducible, which is a **precondition**, not
progress toward §5. Unchanged and still true: every release gate G1-G6 is **unavailable** because
no monetary reservation path, ledger schema, tenant authorization, operational stack or admin
ledger view exists yet. No §5 clause is satisfied. There is no deployment, no real provider
credential, no real spend, no real user, no backup or restore drill, no rollback drill and no soak
window. The repository is **not yet in production**.

### §10.1 next selected

With `dev:health` green and no failing gate, the highest remaining item is §10.1(6): a claim with
no regenerating command. Audit every number and capability claim in `README.md`,
`SUPPORT_MATRIX.md`, `docs/` and the register against a committed command that regenerates it, and
either regenerate or withdraw each one. Tier 0's remaining dependency-admission reviews
(live upstream, historical advisory, legal obligation, platform support, measured runtime cost)
follow as §10.1(7).
