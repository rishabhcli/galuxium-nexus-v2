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
