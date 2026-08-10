# ADR-0001: Toolchain and repository boundaries

- **Status:** Accepted; Tier 0 implementation and verification in progress
- **Date:** 2026-08-09
- **Decision scope:** Repository foundation and workspace ownership

## Context

The system must make monetary authorization decisions under concurrency, so type drift, undeclared dependencies, and imports that bypass an ownership boundary are correctness risks rather than style concerns. A clean checkout must use one reproducible toolchain and expose one command surface. Domain packages must remain independent of UI, transport, cloud SDK, and framework state, while applications and adapters may orchestrate only through explicit package exports.

The repository also has two documentation locations with different responsibilities. `GOAL.md` requires architectural decisions in root `adr/`, while the planned layout in `README.md` assigns broader engineering material to `docs/`. This decision removes ambiguity without moving or rewriting either authoritative document.

## Decision

### Pinned toolchain

The repository targets:

- Node.js **24.18.0 LTS**;
- npm **11.16.0**;
- TypeScript **6.0.3**;
- npm workspaces rooted in one repository-level package manifest and one committed npm lockfile.

The implementation must pin these values in machine-readable files and fail before build or service startup when the active Node or npm version differs. Dependency installation in verification and CI must use the immutable-lockfile path (`npm ci`), never an unconstrained install.

### Type and runtime-boundary posture

All production TypeScript must compile under `strict` mode. The shared compiler contract must additionally enable the practical checks that expose unsafe indexed access, optional-property ambiguity, implicit control-flow exits, unsafe overrides, and unknown caught values. Individual workspaces may strengthen the shared contract but may not weaken it.

Compile-time types do not validate HTTP, environment, database, Redis, provider, file, webhook, or serialized-message input. Every such boundary must have a versioned runtime schema and an explicit rejection path. Unvalidated dictionaries, unconstrained `any`, and third-party SDK objects may not cross an ownership boundary.

### Workspace ownership

The npm workspace graph follows the ownership map already declared by the repository:

- `services/gateway` owns authenticated admission, quote, reserve, and provider dispatch orchestration;
- `services/reconciler` owns uncertain outcomes, delayed usage, and provider-invoice reconciliation;
- `packages/ledger` owns monetary accounts, reservations, settlement, release, and adjustments;
- `packages/pricing` owns versioned price data and worst-case quotes with explicit units;
- `packages/adapters` owns validation and translation at provider boundaries;
- `packages/observability` owns redacted logs, metrics, traces, and audit-event transport;
- `apps/admin` owns the operator interface and consumes authoritative APIs rather than reimplementing policy.

Boundary rules must be executable and build-failing:

1. Domain packages do not import applications, services, transport frameworks, UI code, cloud SDKs, or adapter implementations.
2. Adapters may depend on domain contracts but never export raw provider SDK objects.
3. Services and applications orchestrate exported capabilities; they do not reach into another workspace's source tree or duplicate domain algorithms.
4. No workspace imports another workspace through a relative filesystem escape. Cross-workspace imports use declared package exports.
5. Circular workspace dependencies, undeclared dependencies, catch-all `utils` packages, and deep imports outside declared exports fail verification.
6. A new top-level workspace requires an ADR covering ownership, dependency direction, failure model, operational cost, and reversal.

TypeScript project references, dependency-cruiser rules, and a TypeScript-AST manifest-declaration scanner enforce the graph. The scanner refuses a production source import unless its owning workspace directly declares the imported package, even when a root development dependency is hoisted and resolvable. Both checks carry executable negative fixtures and run inside `verify-all`; lint alone is insufficient.

### Command contract

The root npm command surface will include build, test, lint, format-check, typecheck, dependency-boundary validation, and `verify-all`. The README command names and the GOAL command names will be aliases over the same underlying tasks rather than competing pipelines. Formatting inside verification is a check and may not mutate the checkout.

`verify-all` must run from a clean checkout with only documented, validated configuration. A missing test suite, warning, changed generated artifact, unlocked dependency, or skipped workspace is a failure, not a successful empty run.

### Documentation ownership

- Root `adr/` is the authoritative home for numbered architecture decisions.
- `docs/` owns runbooks, threat models, dependency governance, evaluation protocols, and other non-ADR operational material.
- A document may link across these locations but may not duplicate an ADR as a second source of truth.

### Dependency admission

Every direct dependency must be entered in `docs/DEPENDENCIES.md` before acceptance. The entry must cover the exact version or digest, licence evidence, maintenance status, security history, install scripts and native/binary behavior, runtime or bundle cost, replacement boundary, and the command or artifact that verifies the statement. Transitive dependencies remain pinned by the lockfile and are included in vulnerability, licence, and SBOM checks.

## Threat analysis

| Threat | Required control |
|---|---|
| A developer or CI runner silently uses a different Node/npm behavior | Machine-readable exact pins plus a preflight version refusal |
| Lockfile mutation or an unconstrained install changes transitive code | Committed lockfile, `npm ci`, and a clean-tree check after verification |
| Dependency lifecycle scripts execute arbitrary code | Default-deny or explicit review of install scripts; record each exception in the dependency register |
| A compromised or abandoned package enters a monetary path | Admission review, provenance and maintenance evidence, vulnerability scanning, lockfile diff review, and a narrow replacement boundary |
| TypeScript path aliases bypass workspace ownership | Enforce declared package exports and dependency-graph rules independently of editor resolution |
| Runtime data is trusted because TypeScript compiled | Runtime schemas and typed rejection errors at every serialized or external boundary |
| Domain logic imports framework or mutable process state | Build-failing import rules and project-reference direction |
| A package exposes sensitive values through logs or errors | Structural redaction APIs owned by observability and tested at callers |
| Generated output or caches leak into commits | Redirect tool output to ignored repository-local paths and fail on unexpected tracked changes |
| Two verification aliases drift into different gate sets | One canonical implementation behind every full-verification alias |

## Alternatives considered

### pnpm or Yarn workspaces

Both provide capable monorepo features. They add another package-manager runtime and a second version/provisioning decision. npm workspaces are sufficient for the declared ownership graph and keep bootstrap coupled to the pinned Node distribution. Reconsider only with measured evidence that npm cannot meet installation, determinism, or workspace performance requirements.

### Bun or Deno as the runtime

Rejected because the approved direction is TypeScript on Node and the target providers, database libraries, tracing stack, and operational tooling are primarily validated against Node. A runtime migration would require contract, performance, cancellation, diagnostics, and deployment requalification.

### Independent repositories or an unstructured single package

Independent repositories make atomic contract changes and clean-checkout verification harder. One unstructured package makes ownership violations invisible. npm workspaces preserve atomic changes while keeping boundaries machine-checkable.

### ADRs under `docs/adr/`

Rejected for this repository because `GOAL.md` explicitly names root `adr/`. The broader `docs/` directory remains useful and has a separate purpose.

### Permissive TypeScript followed by later hardening

Rejected. Retrofitting strictness creates a large ambiguous migration precisely in the monetary core. The strict contract applies before feature code.

## Consequences

### Positive

- Clean-checkout behavior has one versioned toolchain and lockfile.
- Ownership mistakes become local build failures rather than review conventions.
- Domain code remains portable and testable without framework or network state.
- Documentation has one unambiguous ADR location.

### Costs and limitations

- Exact version pins require deliberate upgrade work and CI image maintenance.
- Strict runtime validation and package exports add code and review overhead.
- npm lifecycle execution is denied by committed `.npmrc` policy and the supported bootstrap passes `--ignore-scripts`; any future required installer becomes an explicit reviewed bootstrap boundary rather than silently weakening this default.
- This decision does not select application frameworks, database libraries, validation libraries, test runners, or UI dependencies. Each must pass dependency admission before use.

## Reversal and migration

The decision is reversible through a later ADR with equal or stronger reproducibility and boundary guarantees. A package-manager change must generate a new lockfile from reviewed manifests, compare the resolved dependency graph and lifecycle scripts, rerun the SBOM/licence/security checks, and pass every clean-checkout gate. A runtime or TypeScript change additionally requires contract, performance, cancellation, and deployment requalification.

Moving ADRs would require an atomic link update and a compatibility index at the former location so historical references remain resolvable.

## Verification required before this decision is considered fully held

The repository now contains the exact version-refusal tests, strict compiler configuration, npm workspaces and lockfile, project-reference and dependency-cruiser boundaries (including a negative fixture), canonical verification orchestration, dependency register, and CI workflow described above. The following evidence must still be produced from the final frozen tree and must not be inferred from this ADR:

- exact Node, npm, and TypeScript version-refusal tests;
- immutable `npm ci` from a clean checkout;
- build-failing positive and negative workspace-boundary fixtures;
- `verify-all` coverage proving every workspace participates;
- lockfile, dependency register, vulnerability/licence outputs, and SBOM agreement;
- CI log showing the same command succeeds with warnings treated as failures.
