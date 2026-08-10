# AGENTS.md

> **Repository:** Galuxium Nexus V2
> **Product-name status:** unassigned; do not invent one.

## Scope

These instructions apply to every file and subdirectory in this repository. They are binding for coding agents, review agents, automation, and human contributors unless the user gives a more specific instruction.

## Read order and authority

Before planning or editing, read in this order:

1. `HACKATHON.md` for external requirements and deadlines.
2. `WINNING_IDEA.md` for the selected concept, technical core, validation, and scope.
3. `README.md` for the production product and operating contract.
4. This file for implementation discipline.

Do not infer missing requirements from another hackathon repository. If two documents conflict, stop the affected implementation path, identify the exact conflict, and resolve it in an ADR or user instruction. Do not silently choose the easier interpretation.

## Mission

Provide a production control plane that prevents any tenant from authorizing AI-provider work beyond its configured dollar ceiling, even under concurrent requests, crashes, retries, delayed usage, provider ambiguity, and multi-model pricing.

## Production posture: no MVP track

This repository does not permit an MVP, proof-of-concept, demo-only fork, or “make it work now, harden later” path. The target is a deployable, supportable product. Build in small vertical slices when useful, but every merged slice must already honor production boundaries.

The following are not acceptable in shipped code:

- placeholder implementations, no-op handlers, hardcoded success, fake metrics, canned model/provider results, or static hero data presented as live;
- runtime mocks, demo flags that bypass safety/correctness, or separate judging-only behavior;
- unbounded retries, swallowed exceptions, empty catch blocks, silent fallback to a different algorithm/data source, or success after partial failure;
- undocumented environment variables, secrets in source/logs, mutable global configuration, or production behavior selected by branch name;
- TODO/FIXME comments standing in for correctness, security, privacy, accessibility, migration, rollback, or test work;
- broad interfaces with unvalidated dictionaries/`any` values where a domain type or schema is possible;
- adding scope because it is visually impressive while a core invariant or release gate is still failing.

A temporary test double is allowed only inside tests and must model failure as well as success. A spike may exist on an explicitly disposable branch, but none of it is merged until rewritten to the production contract.

## Product boundaries

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

### Out of scope until explicitly approved

- A dashboard that alerts after overspend
- A model router unrelated to budget correctness
- Provider invoice replacement
- Using Redis counters as the financial source of truth
- A soft rate limit marketed as a hard dollar guarantee

Do not create a product name, marketing identity, pricing promise, partnership claim, or new target user without explicit user approval. Use descriptive component names only.

## Domain invariants

Every change must preserve these rules:

1. No provider call starts without a committed reservation
2. Available budget never becomes negative under any interleaving
3. Every reservation reaches exactly one terminal accounting state
4. Settlement and release are idempotent and balanced
5. Pricing/config version used for authorization is retained forever with the attempt
6. Unknown external outcome remains reserved until reconciled or explicitly adjusted
7. Tenant identity and ledger queries are scoped at every layer
8. Caches may deny unnecessarily but may never authorize money

Treat invariant violations as defects even when the happy-path demo still works. Encode invariants in types, database constraints, protocol schemas, assertions at trust boundaries, and tests. Do not rely on comments or UI copy alone.

## Architecture and ownership

Multi-tenant services deploy independently behind authenticated APIs. PostgreSQL is the authoritative ledger; workers are idempotent, horizontally scalable, and safe under at-least-once delivery.

| Area | Production responsibility |
|---|---|
| `services/gateway` | Authenticated admission, quote, reserve, provider dispatch |
| `services/reconciler` | Uncertain attempts, delayed usage, provider invoice comparison |
| `packages/ledger` | Accounts, reservations, settlement, releases, adjustments |
| `packages/pricing` | Versioned provider/model/token/tool pricing and worst-case quote |
| `packages/adapters` | Provider idempotency, streaming usage, normalized outcomes |
| `apps/admin` | Limits, ledger, attempts, alerts, policy and incident controls |
| `packages/observability` | Traces, metrics, audit events, redaction |

Rules for boundaries:

- Domain packages may not import UI, transport, cloud SDK, or framework state.
- Adapters translate external formats into validated domain types and retain provenance.
- Applications orchestrate domain capabilities; they do not reimplement algorithms or policy.
- Persistent data has a single authoritative owner, explicit schema/version, migration, retention, and rollback story.
- External SDK/provider objects do not cross the adapter boundary.
- Cross-component communication uses typed, versioned contracts and idempotency where delivery can repeat.
- Avoid circular dependencies, catch-all `utils` modules, and business logic in controllers/components.
- New top-level components require an ADR explaining ownership, dependencies, failure model, and operational cost.

### Approved technical direction

- TypeScript/Node services and admin UI
- PostgreSQL double-entry reservation/settlement ledger
- Serializable transactions or explicit row/advisory locking
- Provider adapters with versioned pricing
- Redis only for cache/coordination, never monetary authority
- OpenTelemetry, Prometheus-compatible metrics, property/concurrency/chaos tests

Do not substitute a stack merely because an agent knows it better. A change must improve the production requirements and include migration/operational analysis.

## Data, model, and algorithm rules

- Define schemas at ingestion and reject or quarantine invalid input; never let malformed data drift into domain logic.
- Retain provenance, units, timestamps/timezones, versions, and uncertainty needed to reproduce a result.
- Separate training/tuning, validation, and held-out evaluation by immutable manifest when ML/statistics are used.
- Keep deterministic baselines and ablations beside learned methods.
- Seed randomized tests/jobs and record seeds in artifacts.
- Never print a benchmark, accuracy, health, environmental, financial, or impact claim that a committed command cannot regenerate.
- Prefer explicit abstention/refusal over an invented value.
- Version algorithms, prompts, model identifiers, content packs, calibration, schemas, and policy that can change outputs.
- Treat external model/provider output as untrusted and validate it against a typed schema and deterministic rules.

Project-specific verification surfaces:

- State-machine/property tests for every reservation lifecycle
- High-concurrency oversubscription attempts
- Crash at every boundary before/after DB/provider operations
- Duplicate messages/webhooks and out-of-order usage
- Provider timeout/stream cancel/unknown outcome
- Tenant-isolation, authorization, audit, load, and failover tests

## Security, privacy, and safety rules

- Secrets live in a manager and never in logs/client bundles
- Strong tenant isolation and scoped API keys
- Immutable audit events for limit/policy/manual adjustment changes
- Kill switches operate per tenant, provider, model, and globally

Additionally:

- Run a threat analysis before adding a new external input, credential, file parser, network target, side effect, or public endpoint.
- Enforce authentication and authorization server-side and at data access; client checks are only UX.
- Use least-privilege service identities and short-lived credentials where available.
- Redact secrets and sensitive values structurally, not with best-effort string replacement.
- Set size, time, concurrency, memory, and rate limits at every untrusted boundary.
- Validate redirects, URLs, file types, decompression, archive contents, and callback/webhook authenticity as relevant.
- Any real-world side effect must be previewable or policy-authorized, idempotent where possible, auditable, cancellable when possible, and reconciled after uncertain outcomes.
- Security controls may fail closed; they may never silently disable themselves for a demo.

## Implementation standards

### Types and contracts

- Use the strictest practical compiler/type settings.
- Validate runtime boundaries even when compile-time types exist.
- Represent domain states with explicit enums/tagged unions; make invalid transitions unrepresentable where possible.
- Include units in type/name, and use explicit timezone-aware types for time.
- Version serialized contracts before compatibility matters, not afterward.

### Errors and cancellation

- Errors have stable codes, safe user messages, internal context, and retryability classification.
- Preserve root causes without leaking secrets.
- Propagate cancellation and deadlines across workers, network calls, model calls, and child processes.
- Cleanup is idempotent and tested after cancellation/crash.

### Concurrency and persistence

- State transitions are atomic at the authoritative store.
- At-least-once delivery is assumed unless the boundary proves otherwise.
- Use idempotency keys and reconciliation for external operations.
- Never solve a monetary, safety, or authority race with an eventually consistent cache.
- Schema migrations are forward/backward compatible over the declared rollout window and include rollback or roll-forward recovery.

### Observability

- Use structured logs, metrics, and traces with stable event names and correlation/run IDs.
- Record decisions, versions, durations, retries, refusals/abstentions, and terminal outcomes.
- Do not log raw user content, credentials, sensitive media, health data, private locations, or full third-party transcripts unless an approved encrypted retention policy requires it.
- Every alert links to a runbook and measures user impact, not merely infrastructure noise.

### Dependencies

- Pin direct and transitive dependencies with a lockfile.
- Check license, maintenance, security history, binary/native implications, and bundle/runtime cost.
- Wrap external SDKs behind adapters.
- Generate an SBOM/release manifest for deployable artifacts.

## Testing requirements

A change is incomplete until the relevant layers pass:

1. **Unit tests:** pure domain rules, parsing, transitions, math and errors.
2. **Property/fuzz tests:** serialization, state machines, geometry/signal/solver spaces, parser robustness, and invariants.
3. **Integration tests:** real database/filesystem/browser/device/cloud/provider boundary in an isolated environment.
4. **Contract tests:** schemas and adapters against recorded/versioned fixtures, including provider drift.
5. **End-to-end tests:** complete user outcome, invalid input, cancellation, retry, restart, and recovery.
6. **Evaluation:** held-out domain metrics, baselines, calibration/uncertainty and reproducible artifact.
7. **Security/privacy:** authorization, injection, secret/log redaction, malicious input, rate/size limits.
8. **Accessibility:** keyboard, screen reader semantics, focus, contrast, reduced motion and non-visual equivalents.
9. **Performance/resilience:** latency/memory/frame/bundle/job budgets, load, resource exhaustion, dependency outage and fault injection.

Do not weaken, skip, quarantine, or mark flaky a failing test to merge. Fix the cause or document a reviewed removal of an invalid test. Test the failure path with the same seriousness as success.

## User experience rules

- The primary user outcome must be reachable without developer narration.
- Loading, empty, partial, stale, offline, unsupported, permission-denied, canceled, failed, and recovered states are designed states.
- Never use a green/success state for unknown, partial, low-confidence, or unverified output.
- Accessibility and responsive behavior are implemented with the component, not after feature freeze.
- No dead controls, fake progress, optimistic success before durable completion, or hidden destructive action.
- Technical evidence and limitations must be visible where users act on the result.

## Operational readiness

Before a production deployment exists, implement and document:

- typed environment/configuration validation;
- health and readiness semantics;
- SLOs and error-budget indicators;
- redacted logs, metrics, traces and dashboards;
- backup/restore and data migration where state exists;
- deployment, rollback, and emergency-disable procedures;
- resource ownership/TTL/cleanup;
- incident severity, escalation, and post-incident evidence;
- support matrix and known limitations.

Local and test environments must make real-world side effects impossible by default. Staging is production-shaped with synthetic/de-identified data.

## Release gates

1. Linearizability/concurrency suite shows zero over-authorization
2. Ledger balances under property and chaos tests
3. Unknown-outcome reconciliation and manual adjustment are audited
4. Tenant isolation/security review passes
5. SLOs, alerts, runbooks, backups, and restore drill pass
6. Admin UI never disagrees with authoritative ledger state

No agent may waive a gate. If a gate is impossible or invalid, produce evidence, propose a replacement with equal or stronger protection, and wait for review before changing it.

## Prohibited shortcuts

- Authorizing from an eventually consistent cache
- Treating provider-reported usage as exactly-once
- Silently releasing a reservation after timeout
- Adding a prettier dashboard before the ledger correctness proof

Also prohibited: empty scaffolding presented as progress, mass-generated boilerplate without ownership, copying code from another project without license/provenance review, demo-only auth or secrets, fabricated user research, fabricated benchmark results, and screenshots that imply unimplemented functionality.

## Required agent workflow

1. **Inspect:** read all authoritative docs, repository state, tests, configs, and relevant dependencies before editing.
2. **State the slice:** define the production user outcome, boundaries touched, invariants, threats, data migrations, observability, and acceptance tests.
3. **Design:** add/update an ADR for a new architectural dependency, persistent schema, external side effect, model, security boundary, or major algorithm.
4. **Implement vertically:** domain logic, adapter, UI/API, error states, telemetry, migrations, and documentation together.
5. **Verify:** run formatting, static analysis, unit/property, integration, E2E, domain evaluation, security, accessibility, and performance checks that apply.
6. **Review:** inspect the diff for cross-project leakage, fake data, secrets, permissive fallbacks, dead code, and weakened claims.
7. **Handoff:** report behavior delivered, commands run, evidence/metrics, risks, migrations, rollback, and remaining blocked items.

Do not stop at a plan when the user asked for implementation. Do not claim completion based on compilation or a single happy-path screenshot.

## Definition of done

A task is done only when:

- the supported user outcome works end to end in the intended environment;
- domain invariants are encoded and tested;
- invalid, unsupported, low-confidence, and dependency-failure paths are correct;
- authorization, privacy, safety, accessibility and performance requirements pass;
- observability makes success and failure diagnosable without exposing sensitive data;
- migrations, deployment, rollback and cleanup are reproducible;
- documentation and architecture match the implementation;
- no placeholders, stubs, hidden demo paths, unverified claims, or production TODOs remain;
- release gates relevant to the change pass from a clean checkout.

## Commit and review hygiene

Keep commits coherent and reviewable. Never mix generated artifacts, unrelated formatting, or cross-repository changes into a feature commit. Do not rewrite public history unless explicitly instructed. Before push, verify the exact staged file list, inspect the diff, and ensure no credential or sensitive fixture is included.
