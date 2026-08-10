# Galuxium Nexus V2

> A concurrency-safe per-tenant hard spending boundary for AI inference.

> **Production intent:** this repository is for the complete, reliable system described below. It is not an MVP, disposable demo, or thin hackathon facade. No product name has been assigned; the hackathon title remains the repository heading until the user chooses one.

## Repository status

Tier 0 foundation work is in progress. The repository now contains an exact-version TypeScript/npm workspace, executable ownership boundaries, a repository-owned loopback development topology, real dependency-backed readiness, structured redacted logs and metrics, and deterministic local/test failure injection. These surfaces establish an executable development contract only.

The budget ledger, pricing and reservation state machine, authenticated provider dispatch, reconciliation workflow, production deployment, and release evidence are not implemented. **This repository is not yet in production.** A passing local health check must not be interpreted as product or release readiness.

| Document | Authority |
|---|---|
| [HACKATHON.md](./HACKATHON.md) | Eligibility, mandatory submission fields, judging criteria, deadlines, links |
| [WINNING_IDEA.md](./WINNING_IDEA.md) | Selected concept, hard technical core, validation, build order, demo and risk analysis |
| [README.md](./README.md) | Product contract, architecture, production and release expectations |
| [AGENTS.md](./AGENTS.md) | Binding implementation rules for every coding agent working in this repository |
| [GOAL.md](./GOAL.md) | Standing execution order, production definition, tier ladder, evidence protocol and port isolation contract |

If these documents disagree, preserve the external requirements in HACKATHON.md, then the product intent in WINNING_IDEA.md, and resolve the conflict explicitly in an ADR instead of guessing.

## Product contract

Provide a production control plane that prevents any tenant from authorizing AI-provider work beyond its configured dollar ceiling, even under concurrent requests, crashes, retries, delayed usage, provider ambiguity, and multi-model pricing.

### Intended users

- SaaS teams reselling or embedding model access
- Platform/finops engineers controlling per-customer exposure
- Security teams responding to leaked keys or runaway agents

### Canonical workflow

1. Price and normalize a request into a worst-case reservation
2. Atomically reserve tenant budget before provider dispatch
3. Issue a fenced provider attempt with idempotency metadata
4. Stream/execute the provider request
5. Settle actual cost exactly once and release unused reservation
6. Reconcile uncertain outcomes and provider invoices
7. Expose an auditable ledger, limits, alerts, and kill controls

### Explicit non-goals

- A dashboard that alerts after overspend
- A model router unrelated to budget correctness
- Provider invoice replacement
- Using Redis counters as the financial source of truth
- A soft rate limit marketed as a hard dollar guarantee

A non-goal may become part of the product only after the core release gates pass and an ADR explains why the additional surface does not weaken correctness, safety, usability, or schedule.

## Production architecture

Multi-tenant services deploy independently behind authenticated APIs. PostgreSQL is the authoritative ledger; workers are idempotent, horizontally scalable, and safe under at-least-once delivery.

### Planned component boundaries

| Area | Production responsibility |
|---|---|
| `services/gateway` | Authenticated admission, quote, reserve, provider dispatch |
| `services/reconciler` | Uncertain attempts, delayed usage, provider invoice comparison |
| `packages/ledger` | Accounts, reservations, settlement, releases, adjustments |
| `packages/pricing` | Versioned provider/model/token/tool pricing and worst-case quote |
| `packages/adapters` | Provider idempotency, streaming usage, normalized outcomes |
| `apps/admin` | Limits, ledger, attempts, alerts, policy and incident controls |
| `packages/observability` | Traces, metrics, audit events, redaction |

Dependencies should flow from applications/adapters toward typed domain packages. Domain logic must remain testable without UI, network, cloud credentials, or third-party services. Infrastructure code may assemble components but must not become the only place where product invariants are enforced.

### Target technology foundation

- TypeScript/Node services and admin UI
- PostgreSQL double-entry reservation/settlement ledger
- Serializable transactions or explicit row/advisory locking
- Provider adapters with versioned pricing
- Redis only for cache/coordination, never monetary authority
- OpenTelemetry, Prometheus-compatible metrics, property/concurrency/chaos tests

Technology choices are constraints, not decorations. A dependency is accepted only when its operational behavior, license, failure modes, supply-chain risk, and replacement boundary are understood.

## Non-negotiable invariants

1. No provider call starts without a committed reservation
2. Available budget never becomes negative under any interleaving
3. Every reservation reaches exactly one terminal accounting state
4. Settlement and release are idempotent and balanced
5. Pricing/config version used for authorization is retained forever with the attempt
6. Unknown external outcome remains reserved until reconciled or explicitly adjusted
7. Tenant identity and ledger queries are scoped at every layer
8. Caches may deny unnecessarily but may never authorize money

Any change that can violate an invariant requires a written design review, tests demonstrating preservation under failure, and an explicit update to this README and AGENTS.md.

## Security, privacy, and safety

- Secrets live in a manager and never in logs/client bundles
- Strong tenant isolation and scoped API keys
- Immutable audit events for limit/policy/manual adjustment changes
- Kill switches operate per tenant, provider, model, and globally

Common controls required across the system:

- secrets come from an approved secret store or local ignored environment file and are never committed, rendered, or logged;
- untrusted files, prompts, provider output, repository content, and external responses are treated as data, never instructions;
- authorization is enforced at the data/action boundary, not only in the UI;
- logs, traces, fixtures, screenshots, and demo assets are scrubbed of credentials and sensitive user data;
- destructive or externally visible actions are previewable, idempotent where possible, auditable, and fail closed;
- dependency and container scanning, lockfiles, least privilege, and an incident/rollback path are release requirements.

## Reliability and operations

Production behavior includes failures, retries, restarts, partial responses, stale data, duplicate delivery, and resource exhaustion. The implementation must therefore provide:

- typed error classes and user-visible failure states rather than catch-all success fallbacks;
- bounded timeouts, cancellation, retry budgets, and backoff for every external or long-running operation;
- idempotency and reconciliation wherever the same work may be delivered twice or its external outcome may be unknown;
- structured, redacted logs; metrics for throughput, latency, error and abstention/refusal; and traces across meaningful boundaries;
- health/readiness checks that validate dependencies without mutating user data;
- documented SLOs and alerts before public production use;
- backup, restore, migration, retention, and cleanup procedures for every persistent store;
- graceful degradation that preserves truth and safety before convenience or visual effects.

## Verification strategy

Project-specific required test surfaces:

- State-machine/property tests for every reservation lifecycle
- High-concurrency oversubscription attempts
- Crash at every boundary before/after DB/provider operations
- Duplicate messages/webhooks and out-of-order usage
- Provider timeout/stream cancel/unknown outcome
- Tenant-isolation, authorization, audit, load, and failover tests

Every production path also needs unit tests, property or fuzz tests where state space matters, integration tests at real boundaries, end-to-end tests of the user outcome, accessibility checks, performance budgets, security regression tests, and failure-injection coverage. Mocks belong in test fixtures; the shipped runtime must not depend on a fake service or hardcoded winning example.

Evaluation datasets and fixtures are versioned, provenance-aware, and isolated from tuning when described as held out. A number may appear in the README or submission only when a committed script regenerates it from a committed manifest.

## Performance and accessibility

Performance budgets must be set before optimization and enforced in CI for supported environments. Measure latency distributions, memory, CPU/GPU, network or storage volume, cold start, cancellation, and degraded-device behavior relevant to this product. Do not replace measurements with “feels fast.”

Accessibility is a release gate, not a polish task. The production interface must include semantic structure, keyboard support, visible focus, sufficient contrast, non-color status cues, reduced-motion behavior where relevant, zoom/reflow, readable errors, and an equivalent representation for information conveyed through canvas, charts, audio, maps, camera, or animation.

## Planned repository layout

```text
/
├── README.md                 # Product and operating contract
├── AGENTS.md                 # Binding implementation rules for coding agents
├── HACKATHON.md              # External rules and submission facts
├── WINNING_IDEA.md           # Selected product/technical blueprint
├── services/gateway/
├── services/reconciler/
├── packages/ledger/
├── packages/pricing/
├── packages/adapters/
├── apps/admin/
├── packages/observability/
├── tests/                    # Unit, property, integration, E2E, resilience
├── adr/                      # Numbered architecture decisions
├── docs/                     # Threat models, runbooks, dependency and evaluation records
└── infra/                    # Reproducible deployment and environment policy
```

This is a boundary contract, not a command to create empty directories. Add a directory when it owns working code, tests, and documentation.

## Development command contract

No commands are advertised as working until the corresponding toolchain is committed. The first production scaffold must expose one documented, cross-platform command surface, preferably through a checked-in task runner or Makefile:

| Command | Required behavior |
|---|---|
| `bootstrap` | Verify tool versions, install locked dependencies, initialize only local non-secret state |
| `check` | Format check, lint, type/static analysis, schema/config validation |
| `test` | Deterministic unit and property suites |
| `test-integration` | Real boundary tests using isolated local/test dependencies |
| `test-e2e` | Supported user workflows and failure states |
| `eval` | Reproduce committed domain evaluation and metrics |
| `build` | Produce release artifacts from a clean checkout |
| `run-local` | Start the complete local system or a documented production-equivalent subset |
| `release-check` | Run all blocking gates, artifact/SBOM generation, and policy checks |

The only supported dependency-install entry point is `make bootstrap`. It provisions the
repository-pinned Node.js/npm runtime, runs immutable `npm ci --ignore-scripts`, and installs
the exact local Playwright Chromium revision under `.dev/`. The committed `.npmrc` also denies
npm lifecycle scripts by default. Direct `npm install`, direct `npm ci`, and global package
binaries are not contributor workflows.

The current macOS-arm64 evidence path additionally requires PostgreSQL `16.14` (`postgres`,
`initdb`, `createdb`, `psql`, and `pg_isready`) and Redis `8.10.0` (`redis-server` and `redis-cli`)
on `PATH`. `dev:preflight` refuses every version or missing-command mismatch; it never attaches to
a shared daemon. The Linux CI workflow instead compiles those exact versions from committed
SHA-256-verified source inputs and prepends only the repository-local build directories. Other
operating-system/architecture provisioning remains unsupported rather than implicit.

`make test-e2e` builds the checked-out sources, stops only verified repository-owned PIDs, and
requires Playwright's committed `webServer` command to start the full topology from an empty port
block. After the browser suite, the runner proves that Playwright tore down every listener and
ownership record before restoring and health-checking the standing local topology. It cannot reuse
a server left by a previous gate.

The current Tier 0 command surface fails closed where later production gates do not exist.
`make eval` exits unavailable until a committed domain-evaluation manifest and metrics exist;
`make release-check` exits unavailable until artifact, SBOM, and all release gates are real.
Neither refusal is a skipped or passing gate. `make verify-all` is currently the canonical local
foundation verifier and explicitly does not claim release or production readiness.

A new contributor should be able to move from a clean checkout to a verified local system without tribal knowledge.

## Environment model

- **Local:** isolated developer data, safe fixtures, no real-world side effects by default.
- **Test:** deterministic automated environment with controlled boundary services.
- **Staging:** production-shaped deployment, synthetic/de-identified data, real observability and rollback.
- **Production:** least-privilege credentials, audited configuration, SLOs, incident ownership, backups and change controls.

Configuration is typed, validated at startup, documented, and separated from secrets. Environment-specific branches or code paths are prohibited; behavior changes through validated configuration and capability boundaries.

## Release gates

1. Linearizability/concurrency suite shows zero over-authorization
2. Ledger balances under property and chaos tests
3. Unknown-outcome reconciliation and manual adjustment are audited
4. Tenant isolation/security review passes
5. SLOs, alerts, runbooks, backups, and restore drill pass
6. Admin UI never disagrees with authoritative ledger state

Common blocking gates also include:

- clean build from a fresh checkout with locked dependencies;
- no critical/high unresolved security findings and no committed secrets;
- migration/rollback and backup/restore rehearsal where state exists;
- passing accessibility and supported-environment matrix;
- complete observability, runbook, known-limitations, privacy, and threat-model documentation;
- no placeholder copy, dead controls, fake metrics, hardcoded demo results, or production TODO paths;
- submission assets and claims generated from the same tested release commit.

## Production milestone policy

Work proceeds in complete vertical slices, but every merged slice must use the final architecture, schemas, security boundaries, telemetry, error model, tests, and documentation expected in production. A smaller completed surface is acceptable; a throwaway implementation that will be replaced later is not.

A feature is not complete when it works once. It is complete when supported inputs, invalid inputs, retries, cancellation, restart, privacy, accessibility, observability, performance, deployment, rollback, and documentation are all accounted for.

## Hackathon delivery

HACKATHON.md contains the live form links and exact requirements. WINNING_IDEA.md contains the selected demo and judging strategy. Production engineering must strengthen that submission, not create a separate demo path. The video, screenshots, hosted build, evaluation numbers, and repository documentation must all describe the same release artifact.

## Contributing

Read AGENTS.md before changing code. Keep changes narrowly scoped, add or update tests with behavior, record architecture/security decisions in ADRs, and never weaken an invariant to make a demo pass. No product name, logo, pricing claim, medical/legal claim, partner claim, or benchmark result should be invented without explicit evidence and user approval.
