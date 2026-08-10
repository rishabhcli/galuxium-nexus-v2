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
