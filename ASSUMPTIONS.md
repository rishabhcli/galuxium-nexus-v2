# Assumptions

This file records decisions made without an explicit authoritative requirement or user instruction. Entries are append-only: corrections add a superseding entry and preserve the original text. Each entry must include its impact, the safest interpretation chosen, and the cheapest concrete verification.

Explicitly directed decisions belong in ADRs rather than being relabeled as assumptions.

## Entries

No implementation assumptions have been recorded yet.

## 2026-08-09 — correction: Tier 0 implementation assumptions

The sentence above described the initial documentation-only state and is superseded by the entries below.

### Exact Node and npm patch versions

- **Decision:** use Node.js `24.18.0` and its npm `11.16.0` as exact repository toolchain versions rather than a floating Node 24 line.
- **Impact:** bootstrap downloads a checksummed upstream runtime for the current supported platform, and every command refuses any different patch version. Upgrades require an intentional lockfile and evidence refresh.
- **Safest interpretation:** an exact patch prevents the concurrently changing host toolchain from silently changing build or dependency-resolution behavior.
- **Cheapest verification:** run `node tooling/bootstrap.mjs`, then `node tooling/run-npm.mjs run toolchain:check`; the unit refusal tests exercise mismatched versions.

### Native local PostgreSQL and Redis ownership

- **Decision:** interpret the requirement that every listed service writes a PID and that `dev:down` stops only those PIDs literally: PostgreSQL and Redis run as repository-started native host processes rather than behind the shared Docker daemon.
- **Impact:** local verification requires exact PostgreSQL `16.14` and Redis `8.8.0` binaries, while all data and identity records remain under `.dev/`. ADR-0002 records alternatives and reversal conditions.
- **Safest interpretation:** directly owned, identity-checked host PIDs avoid both shared-daemon ambiguity and any need to signal a process this repository did not start.
- **Cheapest verification:** run `dev:preflight`, `dev:up`, `dev:health`, and `dev:down`, then inspect only this block with `lsof -nP -a -iTCP@127.0.0.1:4160-4169 -sTCP:LISTEN`.

### Cascading readiness timeout

- **Decision:** bound each development readiness request at `6,000` ms, one second beyond the services' `5,000` ms request deadline.
- **Impact:** a metrics readiness request that fans out across the other services can return its truthful response during machine contention instead of being misclassified as unreachable at `1,500` ms. A truly stuck request still fails within a fixed bound.
- **Safest interpretation:** the health client must wait long enough to receive the server's own bounded refusal, while remaining far below the overall startup timeout.
- **Cheapest verification:** run `tooling/dev/test/readiness.test.mjs` and a loaded `dev:health`; the test asserts both the exact bound and its relation to the server deadline.

### Separate PostgreSQL migration owner and runtime identity

- **Decision:** keep the mandated runtime role `galuxium_nexus_v2`, but initialise the repository-local cluster with a separate `galuxium_nexus_v2_owner` role whose credential is never passed to application services. The runtime role is `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, has a connection limit of 20, does not own the database, and is not a member of the owner role.
- **Impact:** gateway and reconciler readiness can connect and run only explicitly granted operations; schema ownership and future migrations remain a separate local administration boundary. Two ignored mode-0600 secret files are provisioned under `.dev/secrets/`.
- **Safest interpretation:** the required database and role names do not require that the runtime role bootstrap or own PostgreSQL. A distinct owner eliminates the observed superuser and row-security-bypass exposure before tenant-scoped ledger work begins.
- **Cheapest verification:** run `npm run dev:health`; the PostgreSQL readiness query fails unless the database owner and every runtime-role privilege flag match the exact least-privilege contract. `tooling/dev/test/postgres-readiness.test.mjs` attacks each privileged flag.

### Bounded readiness fan-out capacity

- **Decision:** retain a default ledger-health concurrency cap of two, but configure gateway and reconciler for at most eight fresh readiness connections each in the local topology.
- **Impact:** the direct `dev:health` request, admin dependency traversal, and metrics dependency traversal can overlap without making a healthy service refuse itself. Even at both service caps, readiness consumes at most 16 of the repository PostgreSQL server's 50 configured connections; excess probes fail closed before constructing another client.
- **Safest interpretation:** removing the cap would reintroduce unbounded connection accumulation, while a cap of two is below the topology's designed cascading concurrency. Eight is a bounded local operational allowance, not a production sizing claim.
- **Cheapest verification:** run `npm run dev:health` repeatedly and `npm run test:integration`; the ledger unit suite separately proves that the configured cap refuses the next concurrent check without constructing a client.

### Superseding Redis security-patch pin

- **Decision:** supersede the initial Redis `8.8.0` patch pin with exact Redis `8.10.0`, the current upstream GA and Homebrew stable version observed on 2026-08-10.
- **Impact:** all native provisioning inputs, source SHA-256, executable identity checks, readiness expectations, documentation, and dependency evidence must move together. Existing `.dev/redis/` data remains local development state and is accepted only after an exact lifecycle restart and protocol-level health check.
- **Safest interpretation:** Redis `8.8.1` was published as a security release for crafted RedisBloom/TDigest `RESTORE` payloads; staying on a superseded `8.8.0` pin is not acceptable even though the current source build does not intentionally enable those modules. The current GA line includes that fix and avoids retaining a known superseded security patch.
- **Cheapest verification:** run the exact toolchain preflight, rebuild/start the owned topology, assert Redis reports `8.10.0` on DB 6, and regenerate the native dependency provenance and security-history record.

### Nanodollars as the exact monetary unit

- **Decision:** represent money as an integer count of nanodollars (1e-9 USD) carried as `bigint`, bounded to ±1e24 nanodollars (±1e15 USD), with a canonical decimal-integer wire form and no `number` path into or out of an amount. Rates are integer nanodollars per million tokens; every division inside a quote rounds up.
- **Impact:** `packages/ledger` is the sole owner of monetary types and every other package imports them. The eventual PostgreSQL column is `NUMERIC(38,0)` with a `CHECK` asserting the same bound, so an amount the database would reject is refused at the boundary first instead of failing inside an authorization path.
- **Safest interpretation:** microdollars would round the cheapest published per-token prices to zero, and binary floating point cannot represent them at all; nanodollars carry every published rate exactly. Ceiling division is the only rounding direction that keeps a quote an upper bound on a cost that is unknowable until the provider call finishes, which is the property the whole product rests on. The ±1e24 bound is arbitrary in magnitude but not in kind: an unbounded amount cannot be asserted by a database constraint.
- **Cheapest verification:** run `vitest run packages/ledger/test/money.test.ts`; 1,000-case seeded properties assert exact round-tripping, refusal outside the bound, order-independent summation, and that ceiling division never under-covers its input.

### Reservation lifecycle with distinct dispatched and uncertain states

- **Decision:** model the reservation lifecycle as six states — `open`, `dispatched`, `uncertain`, and the terminal `settled`, `released`, `adjusted` — rather than the three the concept sketch implies. Expiry of an `open` reservation releases the hold; expiry of a `dispatched` one moves to `uncertain` and keeps holding the full amount.
- **Impact:** the reaper cannot release anything that may have reached a provider. Only the reconciler, with evidence, or an audited manual adjustment resolves an `uncertain` reservation. The gateway must commit the `open` → `dispatched` transition before calling a provider, which is what makes invariant I1 checkable against a persisted record rather than only against a type.
- **Safest interpretation:** `WINNING_IDEA.md` describes a reaper that releases orphans, and invariant I6 requires an unknown outcome to stay reserved. Those conflict for exactly one case: a reservation whose provider call may have started. Splitting the state resolves it in the direction that cannot leak money, at the cost of holding some budget longer than strictly necessary. The opposite choice — releasing on expiry regardless — is the specific silent leak this product exists to prevent.
- **Cheapest verification:** run `vitest run packages/ledger/test/reservation.test.ts`; 2,000-case seeded properties assert that a terminal state is never left, that held plus settled plus released always equals reserved, that a dispatched expiry moves no money, and that a stale fencing token is refused from every reachable state.

### The ceiling bounds authorization, not realized provider spend

- **Decision:** treat the configured ceiling as a hard bound on what this system authorizes, and record provider usage that arrives after a reservation resolved as unreconciled overspend against a dedicated account rather than debiting available balance.
- **Impact:** a tenant's *recorded spend* can exceed its ceiling by the residual even though every *authorization* stayed within it. Every surface that shows a balance must show the residual and must not render a tenant carrying one as "within cap". Documented under "Scope of the spend guarantee" in `SUPPORT_MATRIX.md`.
- **Safest interpretation:** the two alternatives are worse and both are dishonest in a way this one is not. Discarding late usage hides money that actually left. Debiting available balance drives a tenant negative, violating invariant I2 and destroying the one guarantee the product makes. Recording the residual visibly keeps the global ledger balanced, keeps I2 true, and states the limitation where a user acts on the number. The residual is proportional to reconciliation lag rather than to traffic, so the `GOAL.md` §8 reconciliation-lag ratchet tightens it on every epoch without ever removing it.
- **Cheapest verification:** run `vitest run packages/ledger/test/reservation.test.ts`; the compensation case asserts that late usage after a release produces exactly one `compensate_unreconciled_overspend` movement, leaves the reservation terminal, and never alters the settled or released partition.

### Editing migration `0001` is admissible only until it applies outside a local database

- **Decision:** `packages/ledger/src/migrate.ts` refuses an already-applied migration whose SHA-256 no longer matches, with `MIGRATION_APPLIED_FILE_CHANGED`. When `0001_double_entry_ledger.sql` was corrected on 2026-08-10, the recovery was to `DROP SCHEMA ledger CASCADE` on the local development database and re-apply `0001`, rather than to add an `0002` whose only purpose was correcting a defect that had never reached anything real.
- **Impact:** this is the last point at which that is admissible. The moment `0001` applies to any environment other than a developer's own `.dev/postgres` cluster — staging, CI with retained state, or production — it becomes immutable, and every correction becomes a forward migration. There is no `down` path in the runner by design: rolling a ledger schema back by dropping columns discards evidence.
- **Safest interpretation:** the checksum refusal is the valuable behaviour and must not be softened into a warning. A schema that does not match its migration file is a guess rather than an audit. Dropping a local schema created the same day destroys nothing anyone can observe; silently accepting an edited migration would destroy the ability to know what any environment's schema actually is.
- **Cheapest verification:** edit any applied migration file by one byte and run `npm run db:migrate`; it must exit non-zero with `MIGRATION_APPLIED_FILE_CHANGED` and apply nothing.

### The reserve path refuses by zero rows, never by constraint violation

- **Decision:** `reserveBudget` refuses an unaffordable request by returning `{ outcome: 'insufficient_budget' }` from a conditional single-statement `UPDATE` that affected zero rows. The `budgets_available_never_negative` CHECK is a backstop for a write path that bypassed that statement, not the mechanism by which a normal refusal happens.
- **Impact:** the two must map to different user-visible outcomes. Zero rows is a designed refusal and becomes a 402-shaped response classified as retryable once the hold expires or the budget is credited. SQLSTATE `23514` on that constraint reaching a request path means an invariant was breached by code that should not exist: it must fail closed, be classified non-retryable, page, and block new authorizations for the affected tenant per the Tier 5 fail-closed requirement.
- **Safest interpretation:** mapping the constraint violation to "budget exceeded" would make I2 look enforced while making a real breach indistinguishable from a routine refusal. Every constraint in the migration is therefore explicitly named rather than autogenerated, so the mapping keys off a chosen name and a rename becomes a visible migration instead of a silent behaviour change.
- **Cheapest verification:** run `vitest run tests/integration/ledger-schema.test.ts`; the concurrency case asserts that 45 of 50 simultaneous requests are refused by outcome rather than by exception, and the constraint cases separately assert that the CHECK does fire when a statement writes the row directly.

### Migration 0001 stays malleable only until it applies outside a local database

- **Decision:** the migration runner refuses an already-applied file whose checksum changed. While `0001_double_entry_ledger.sql` has been applied to nothing but a repository-local development database, correct it in place and reset the local schema with `DROP SCHEMA ledger CASCADE` followed by re-applying. From the first application to any environment that is not a local `.dev/` cluster, `0001` is immutable and every correction is a forward migration.
- **Impact:** the `NOT NULL`-on-a-domain defect described below was fixed in `0001` rather than by a `0002` whose only content would be undoing a typo. `ledger.schema_migrations` lives inside the `ledger` schema, so the cascade drops the history with the tables and the re-application is clean rather than partial.
- **Safest interpretation:** shipping a corrective migration that exists only because of a same-day mistake makes the schema history a record of the author's errors rather than of the system's evolution, and every future reader has to reconstruct which pair of migrations is really one intent. Editing in place is only honest while nothing depends on the old shape; the moment anything does, editing becomes rewriting history and the checksum refusal is exactly right to block it. Recording the boundary here rather than leaving it to judgement is the point of the entry.
- **Cheapest verification:** `npm run db:migrate` twice — the second run reports `UNCHANGED 0001_double_entry_ledger.sql`. Editing the file and running again reports `MIGRATION_APPLIED_FILE_CHANGED` and applies nothing.

### `NOT NULL` belongs on the column, never on the domain

- **Decision:** `ledger.nanodollars`, `ledger.nonnegative_nanodollars`, `ledger.positive_nanodollars`, and `ledger.price_book_version` declare only their value space. Nullability is restated on each column.
- **Impact:** `entries.price_book_version` can be NULL, which it must be: a funding credit precedes every attempt and has no authorizing price book version. `entries_price_version_recorded_for_attempt_kinds` makes NULL exactly co-extensive with `credit_funding`, so the nullability is constrained rather than merely permitted.
- **Safest interpretation:** a domain constrains what a value may be; whether a column must have one is a property of the column. Putting `NOT NULL` in the domain silently made every column using it required, and the failure surfaced 18 test failures away from its cause. The integration suite found this; the hand-verification against the live database had not, because every statement it happened to run supplied every column.
- **Cheapest verification:** `vitest run tests/integration/ledger-schema.test.ts` — the funding entry written during tenant seeding cannot be inserted at all if the domains carry `NOT NULL`.

### Every scoped ledger operation runs inside a transaction

- **Decision:** `packages/ledger/src/repository.ts` sets `app.tenant_id` with `set_config(..., true)` — transaction-local — and routes every operation, including read-only ones, through a scoped transaction. `applyScope` reads the setting back and refuses when it did not take.
- **Impact:** there is no cheaper unscoped read path, by design. A pooled connection cannot carry one tenant's scope into another tenant's request, because the scope dies at `COMMIT` or `ROLLBACK`.
- **Safest interpretation:** a session-level `SET` would survive `client.release()` and be inherited by whichever tenant's request next borrowed that connection, which is the specific way connection-pooled row-level security fails. The read-back matters because `set_config(..., true)` outside a transaction is accepted and discarded: without verification the scope would be silently absent and every query would return zero rows, which reads as a missing record rather than a missing scope. That mistake was made and caught here — `readBudget`, `markDispatched`, `markUncertain`, and the post-rollback recovery read in `reserveBudget` all ran outside a transaction initially, and the assertion named it instead of letting them look empty.
- **Cheapest verification:** `vitest run tests/integration/ledger-schema.test.ts` — an unscoped runtime connection is asserted to see zero tenants, and a scoped one exactly its own.
