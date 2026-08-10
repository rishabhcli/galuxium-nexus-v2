# ADR-0002: Local runtime and port isolation

- **Status:** Accepted; Tier 0 implementation and verification in progress
- **Date:** 2026-08-09
- **Decision scope:** Local development processes, state, ports, and shared-machine namespaces

## Context

This repository runs on a machine shared with fifteen sibling repositories. They share the loopback interface, process table, and common tool defaults. A default port, broad process kill, shared database daemon, shared Redis database, or shared browser profile can corrupt another session while appearing locally successful.

The §0A lifecycle contract requires every listed service to have an owned host PID and requires `dev:down` to stop only verified PIDs. Local infrastructure must therefore be isolated without delegating ownership to a shared daemon. A listening TCP socket is not readiness evidence; each service must answer a protocol-appropriate, non-mutating readiness check.

## Decision

### Native repo-local processes

Every local service is a host process started and owned by this repository:

- PostgreSQL **16.14** runs as a native repository-local process;
- Redis **8.10.0** runs as a native repository-local process;
- application and test HTTP services run as compiled Node.js processes under the pinned repository toolchain.

Docker and Docker Compose are not used by the local runtime. PostgreSQL and Redis may use provisioned native binaries, but their exact executable path, version, artifact provenance, and process identity must be validated before startup. They may not attach to or control an already-running global daemon.

All mutable local state is confined to ignored `.dev/`. This includes database files, Redis persistence when enabled, sockets, configuration derived for a run, logs, PID records, locks, scratch files, browser profiles, and redirectable caches. Secrets are provided through ignored, permission-restricted files or inherited descriptors and never command-line arguments or committed configuration.

The deterministic fake provider exists only in local and test environments. It must model deterministic usage plus declared failure injection; it is never a production fallback or a source of evidence about a real provider.

### Exclusive addresses and ports

Every listener binds to `127.0.0.1`, never `0.0.0.0`, `::`, or an implicit framework host.

| Port | Owner | Runtime | Readiness contract |
|---:|---|---|---|
| `4160` | Gateway service | Compiled Node | HTTP readiness response that validates required dependencies without authorizing or spending money |
| `4161` | Reconciler service | Compiled Node | HTTP readiness response that validates worker dependencies and configuration |
| `4162` | Admin UI | Compiled Node | HTTP readiness response from the served application |
| `4163` | Deterministic fake provider | Compiled Node, local/test only | HTTP readiness plus separate deterministic success/failure contract tests |
| `4165` | PostgreSQL 16.14 | Native repo-local process | `pg_isready` followed by a non-mutating query against the intended database and role |
| `4166` | Redis 8.10.0 | Native repo-local process | Redis protocol `PING` with an explicit logical database 6 selection and identity validation |
| `4167` | Prometheus-compatible metrics endpoint | Compiled Node | Parseable Prometheus exposition containing the required process/service identity metric |

Ports `4164`, `4168`, and `4169` remain reserved. They may not be assigned without updating `ports.env`, this ADR or a superseding ADR, and `ASSUMPTIONS.md` when the allocation was not explicitly directed.

No framework or daemon may select a free port. No service may bind a conventional default such as 3000, 5173, 5432, 6379, 8080, or 9090 on the host.

### Repository-local state and namespace isolation

- PostgreSQL database and application runtime role are both `galuxium_nexus_v2`. Cluster bootstrap, schema ownership, and future migrations use the separate `galuxium_nexus_v2_owner` role; its credential is never passed to application processes.
- The runtime role is deliberately non-owning and constrained to `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS` with a connection limit of 20. Readiness rejects any privilege drift or owner-role membership.
- PostgreSQL data, socket, generated runtime configuration, PID metadata, and logs stay under `.dev/`; it binds TCP only to `127.0.0.1:4165`.
- Redis clients select logical database index **6** explicitly; a missing or invalid index is a startup refusal.
- Redis working data, generated runtime configuration, PID metadata, and logs stay under `.dev/`; it binds TCP only to `127.0.0.1:4166`.
- Browser automation uses `./.dev/pw-profile/` only.
- PIDs, logs, PostgreSQL data, Redis state, scratch data, and redirectable caches live under `./.dev/pids/`, `./.dev/logs/`, `./.dev/postgres/`, `./.dev/redis/`, `./.dev/tmp/`, and `./.dev/cache/`.
- `.dev/` is ignored as one unit. Preflight verifies the canonical `.dev/` root with a repository-local probe; committed tests separately assert the required directory layout and ignore contract.
- No local runtime invocation may write a database cluster, socket, persistence file, PID, log, or generated config to a system default directory, home-directory default, sibling repository, or shared temporary directory.

The repository name `galuxium-nexus-v2` prefixes runtime identities that support names. PostgreSQL's underscore-only database and role exception remains `galuxium_nexus_v2`. Because no Compose invocation is used, `COMPOSE_PROJECT_NAME` has no local runtime role; if Compose is introduced later, §0A still requires the exact `galuxium-nexus-v2` project name.

### Lifecycle ownership

`dev:preflight` must:

1. validate the exact Node, npm, TypeScript, PostgreSQL, and Redis versions, `ports.env`, loopback bindings, namespace values, and required `.dev/` layout;
2. prove the configured PostgreSQL and Redis executable identities before either is launched;
3. inspect every port in `4160` through `4169` before starting;
4. distinguish a repository-owned live process from a foreign holder using more than a numeric PID;
5. fail with the holder identity when a foreign process occupies any port;
6. refuse unsafe or missing configuration rather than moving to an out-of-block port or attaching to a global daemon.

`dev:up` starts only this repository's declared native and compiled Node processes. PID identity files are written atomically after the child identity is known. Each record includes the exact PID, process-group ID, process start identity, stable command needles, repository root, run ID, service kind, and expected port. Ownership verification re-inspects the recorded identity, command, and process group immediately before every signal; it does not claim to record a separate executable or cwd field. Logs are service-specific; structural secret-redaction and bounded-log hardening remain required before Tier 0 is accepted. Concurrent lifecycle operations use a repository-local lock whose stale-takeover race hardening remains required before Tier 0 is accepted.

PostgreSQL cluster initialization is explicit, idempotent, and confined to `.dev/postgres/data/`. It initialises the distinct owner identity, creates or repairs the non-privileged runtime role, creates the owner-owned database, revokes public database access, grants only runtime connection access, and then validates the complete privilege posture without modifying a global cluster. Redis starts from a generated repository-local config that fixes its loopback address, port, state directory, log path, and permitted database count. Selecting logical DB 6 remains an explicit client responsibility and is validated by health checks.

`dev:down` validates every recorded process start identity immediately before signalling it, sends graceful termination to that exact process, waits a bounded interval, and escalates only against the same revalidated process if needed. It never stops a service by name pattern, port alone, global service manager, or daemon-wide command.

Stale PID, missing PID, PID reuse, partially initialized PostgreSQL cluster, partially started service, repeated shutdown, and process crash are designed states. Cleanup is idempotent and may report a partial failure, but may not signal an unverified process or delete state it cannot attribute to this repository.

### Health semantics

`dev:health` polls all allocated services with a bounded overall deadline and per-attempt timeout. It uses the native protocol or a meaningful application readiness endpoint, not a TCP-connect-only probe. A response for the wrong database, role, Redis database, executable version, service identity, or configuration version is unhealthy even if the port accepts connections.

Liveness means the process can answer. Readiness means the service has validated configuration and every dependency required for its next supported operation. Neither state means the product's release gates or production requirements have passed.

The Playwright `webServer` target is the admin application on `http://127.0.0.1:4162`. Its command must retain ownership of every process it starts and perform the same bounded, identity-safe teardown when Playwright exits.

## Threat analysis

| Threat | Required control |
|---|---|
| A framework or daemon binds its default or a random free port | Explicit validated port for every process; pre-bind refusal and configuration tests |
| A local service is exposed to the LAN | Explicit IPv4 loopback bind plus a socket-address verification test |
| Another repository already owns a declared port | Preflight holder inspection and fail-closed startup; never kill or silently relocate |
| A stale PID points at a newly reused process | Record exact start identity, process group, stable command needles, repository/run identity, and expected port; revalidate immediately before signalling |
| Concurrent lifecycle commands corrupt PID files | Repository-local lock and atomic file replacement |
| A partial startup leaves orphan processes | Ordered startup, ownership journal, and bounded rollback of only successfully acquired PIDs |
| Broad cleanup destroys sibling work | Exact PID validation; prohibit `pkill`, `killall`, service-wide stop, and equivalent pattern-based cleanup |
| A global PostgreSQL or Redis process is mistaken for this repository's process | Validate the recorded start identity, process group, command needles containing the repository-local config/data path, port, and protocol identity before health or shutdown; strengthen the start identity until same-second PID reuse cannot pass |
| PostgreSQL connects to the wrong database or role | Names fixed to `galuxium_nexus_v2` and readiness query verifies current database and user |
| Redis data crosses repository boundaries | Exact loopback URL plus explicit DB 6 selection and startup/readiness refusal on any URL, port, protocol, authentication, query, fragment, or selected-database mismatch |
| A daemon writes to a system or home-directory default | Generate explicit config and verify every mutable path is beneath the canonical repository `.dev/` root |
| A TCP-only probe reports readiness while initialization or dependencies are broken | Protocol-level and application-level non-mutating readiness checks |
| Fake-provider behavior leaks into production | Environment capability boundary, production config rejection, and tests proving no fallback path |
| Secrets enter logs, PID metadata, process arguments, or generated config | Structural redaction, permission-restricted ignored secret files, and redaction regression tests |
| A native binary is replaced after preflight | Use the exact realpath whose version preflight admitted; separately record executable hashes/provenance in dependency evidence; do not claim the current local launcher closes every filesystem time-of-check/time-of-use race |

## Alternatives considered

### Docker Compose for PostgreSQL and Redis

Rejected for Tier 0. Compose delegates the real host process to a shared Docker daemon and would not give each listed service a repository-owned host PID that `dev:down` can validate and signal under the literal §0A contract. It also introduces daemon, project, container, network, and volume namespaces when native processes can keep all state and ownership under `.dev/`.

If Compose is ever introduced through a superseding ADR, every invocation must still use `COMPOSE_PROJECT_NAME=galuxium-nexus-v2`, but there is no Compose invocation in the accepted local design.

### Containerize every service

Rejected for the same PID-ownership reason and because it increases build and lifecycle surface, obscures application process identity, and makes iteration depend on a shared daemon. Compiled Node processes exercise the intended runtime directly.

### Attach to shared native PostgreSQL and Redis daemons

Rejected. A global service manager, default data directory, or pre-existing daemon does not provide repository-exclusive lifecycle or state ownership. This repository starts exact native versions with explicit `.dev/` paths and owns their PIDs.

### Use framework defaults or dynamically allocated ports

Rejected. Defaults are shared, and dynamic allocation makes browser, health, evidence, and cross-service configuration nondeterministic. The exclusive block is a correctness contract.

### Bind `0.0.0.0` for convenience

Rejected. Local development has no requirement to expose these services beyond loopback, and accidental network exposure increases both collision and security risk.

### Use Redis as monetary authority

Rejected by the domain contract. Redis may coordinate or cache a denial, but it may never authorize spend. PostgreSQL remains the authoritative ledger.

### Stop services by process-name, port, or global service command

Rejected because names and ports do not prove ownership and all repositories share the process table. Only verified repository-owned PIDs may be stopped.

## Consequences

### Positive

- Every listed local service has a directly owned and verifiable host PID.
- Database, cache, logs, sockets, and process state remain attributable and removable under one ignored repository directory.
- Local ports and shared namespaces are deterministic.
- Startup, readiness, and teardown failures become observable testable states.
- The fake provider supports deterministic failure testing without becoming a shipped fallback.

### Costs and limitations

- Exact native PostgreSQL and Redis artifacts must be provisioned and verified for every supported OS/architecture.
- Native daemon configuration, cluster initialization, PID identity, and partial-start rollback require more code than attaching to a global service.
- Repository-local database state is development/test state and does not establish backup, failover, or production deployment readiness.
- Loopback-only development cannot establish public deployment readiness.
- Passing `dev:health` proves only the declared local readiness contract.

## Reversal and migration

Replacing native local dependencies with containers, managed services, or remote dependencies requires a superseding ADR, typed configuration, least-privilege credentials, equivalent process/resource identity and readiness checks, production-shaped test isolation, cost and cleanup ownership, and rollback evidence. Existing `.dev/` data needs an explicit export, compatibility, and deletion procedure; it must never be silently reused by an incompatible major or patch.

The local port block remains unchanged unless GOAL.md is amended or a reserved port is allocated through the documented process.

## Verification required before this decision is considered implemented

No command is claimed to have passed by this ADR. Evidence remains required for:

- exact PostgreSQL 16.14 and Redis 8.10.0 executable provenance, version, checksum/signature where available, and supported architecture;
- proof that all mutable database/cache state, sockets, configs, PIDs, logs, locks, and caches remain under ignored `.dev/`;
- foreign-port refusal and repository-owned stale-process handling;
- explicit loopback binding for every allocated port;
- exact database, role, Redis DB, executable, and service identity;
- protocol-correct readiness and bounded timeout behavior;
- repeated and partial `dev:up`/`dev:down` lifecycle tests, including PID reuse;
- proof that broad kill and global service-management patterns are absent from executable code;
- Playwright startup and teardown confined to this repository;
- PostgreSQL 16.14 and Redis 8.10.0 artifacts admitted through `docs/DEPENDENCIES.md`.
