# Support Matrix

> **Current status:** Not yet in production. The Tier 0 canonical verifier now passes from a clean
> checkout on the Linux runner out of a pushed commit — [Actions run 31428413658](https://github.com/rishabhcli/galuxium-nexus-v2/actions/runs/31428413658)
> at commit `8c2a8ab`, green on every step including native provisioning, bootstrap, the full
> verifier, and the assertion that verification did not rewrite or add repository files. The four
> failures named in the previous revision of this file — the formatting refusal, the gateway
> log-observation integration assertion, Playwright lifecycle teardown residue, and Linux Redis
> native provisioning — are all fixed and their gates are green.
>
> That establishes a reproducible development and verification foundation and nothing beyond it. No
> row below promotes a local or CI result into product, release, staging, or production support, and
> no §6 release gate G1-G6 is available: there is no monetary reservation path, ledger schema,
> tenant authorization, operational stack, or admin ledger view. See the newest
> [PROGRESS.md](./PROGRESS.md) entry for exact commands and evidence.

An entry becomes **Supported** only when a committed command reproduces its acceptance evidence from a clean checkout. A design decision, installed tool, build result, or local smoke test is not enough. Unknown combinations fail closed and must not be presented as degraded-but-supported behavior.

"Supported for development and verification" below means exactly that clean-checkout reproduction
now exists for the development and verification surface named in the row. It is never a statement
about product behaviour, deployment, or a platform a user could run this on.

| Surface | Intended boundary | Current status | Required evidence before support |
|---|---|---|---|
| Node.js runtime | Exact `24.18.0` LTS | Supported for development and verification: checksummed repository-local bootstrap and mismatch refusals pass, and clean-checkout reproduction is green on macOS arm64 locally and ubuntu-24.04 x64 in run 31428413658 | Runtime and deployment matrix for a real environment |
| npm CLI | Exact `11.16.0` with npm workspaces and committed lockfile | Supported for development and verification: immutable lifecycle-disabled bootstrap, mismatch refusal, lock/evidence agreement and clean-checkout Linux CI all pass; release admission still pending | Dependency review closure (live upstream, historical advisory, legal obligation, platform, measured cost) |
| TypeScript | Exact `6.0.3`, strict shared compiler contract | Supported for development and verification: all-workspace typecheck and both negative import-boundary fixtures pass, reproduced from a clean checkout in run 31428413658 | Nothing further for this surface; product correctness is proven by the tier gates, not by the compiler |
| Local PostgreSQL | Native PostgreSQL `16.14` process owned by this repository, all mutable state under `.dev/`, loopback port 4165, database/runtime role `galuxium_nexus_v2`, distinct owner `galuxium_nexus_v2_owner` | Supported for development and verification only: clean-checkout lifecycle and health are green on macOS arm64 and in Linux CI, including least-privilege role checks. Backup, restore and any production use remain unsupported | Native admission closure; schema migration, backup, restore, failover, load, and tenant-isolation evidence |
| Local Redis | Native Redis `8.10.0` process owned by this repository, all mutable state under `.dev/`, loopback port 4166, exact URL and logical DB 6; never monetary authority | Supported for development and verification only: the canonical verifier and clean-checkout Linux CI are green, and CI builds exactly `bin/redis-server` and `bin/redis-cli` from SHA-256-verified source with any loadable module refused. Release admission remains pending | Native admission closure; outage/failover and cache-denial property evidence |
| Local HTTP services | Compiled Node processes bound only to `127.0.0.1` on ports 4160, 4161, 4162, 4163, and 4167 | Supported for development and verification only: clean-checkout verifier and CI health are green. Product behaviour is intentionally unavailable and these endpoints return a foundation-only response | Authentication, authorization, rate/concurrency, resilience, and product-outcome evidence |
| Deterministic fake provider | Local/test deterministic usage and explicit failure injection only | Supported for development and verification only: contract and E2E evidence reproduce from a clean checkout in run 31428413658; startup requires development configuration. Unsupported as a production provider or fallback, permanently | Continuing proof that no production fallback path exists as real adapters are added |
| Admin browser support | Playwright-managed Chromium 151.0.7922.34 revision 1234 only, on macOS arm64 locally and ubuntu-24.04 x64 in CI | Keyboard/semantic and axe critical/serious assertions pass, and the containing owned-lifecycle gate is now green on macOS arm64 and ubuntu-24.04 x64: Playwright's own `webServer` is proven to have started the topology and completed its own teardown, by run id, before the block is required to be empty. **No browser support is declared**: two assertion classes on one engine is not browser support | Screen-reader, contrast, reduced-motion, zoom/reflow, WebKit/Firefox, and manual evidence |
| Provider APIs | No real provider/model/version declared | Unsupported | Versioned adapter contract, real integration and reconciliation tests, provenance and failure matrix |
| Production deployment | No cloud, region, domain, topology, or public release declared | Unsupported; production has not occurred | Full production criteria, deployment/rollback evidence, health/SLOs, soak, real use, incident and restore drills |
| Staging | No environment declared | Unsupported | Production-shaped deployment with synthetic/de-identified data, observability, rollback, and side-effect policy |
| Operating systems and CPU architectures | macOS arm64 for local development; GitHub-hosted Ubuntu 24.04 x64 for CI, with runner-specific source builds | Both declared surfaces now reproduce the verification evidence from a clean checkout: macOS arm64 locally, and ubuntu-24.04 x64 in run 31428413658 with PostgreSQL 16.14 and Redis 8.10.0 built from SHA-256-verified source. That makes each a supported **verification** platform and neither a supported **deployment** platform; no product or release artifact exists for either | Exact native/browser linkage and limitations per platform; production artifact matrix; any platform not in this row remains unsupported |
| External side effects | Disabled unless a future typed policy explicitly authorizes one | Unsupported by default | Threat analysis, preview/policy authorization, idempotency, audit, cancellation, and reconciliation tests |

## Scope of the spend guarantee

The ceiling is a hard bound on **authorization**, not on **realized provider spend**. State the difference wherever a number is shown; presenting the second as the first would be the central false claim this system could make.

- **Bounded absolutely:** the sum of amounts this system authorizes for a tenant. No interleaving of concurrent requests, crashes, retries, duplicate deliveries, or cache failures can authorize more than the configured ceiling. This is the invariant, and it is what the concurrency and chaos gates measure.
- **Not bounded absolutely:** the amount a provider ultimately bills. A provider can report usage for an attempt after this system has already released the hold — the reaper releases an expired reservation only when the attempt was never dispatched, but a provider can still report against an attempt this system had to resolve. That cost is real, is recorded as unreconciled overspend against a dedicated account rather than netted against a live budget, and can therefore push a tenant's *recorded spend* above its ceiling while every *authorization* stayed within it.
- **Consequence for every surface:** a tenant carrying non-zero unreconciled overspend must never be rendered as "within cap" without qualification. The residual is displayed, attributed to the attempt that caused it, and alerted on. A green state for an unreconciled balance would be exactly the "green for unverified output" this repository prohibits.
- **Bound on the residual:** limited to what providers can report after resolution, so it is proportional to reconciliation lag, not to traffic. Tightening the reconciliation-lag ratchet in `GOAL.md` §8 tightens this residual; it never removes it.

This limitation is structural rather than a defect awaiting a fix. The honest alternatives are worse: discarding late provider usage would hide real money, and debiting available balance would let a tenant balance go negative, violating invariant I2.

## Known limitations

- The local status page and readiness APIs are foundation diagnostics, not the canonical budget-control user workflow. No budget API, monetary schema, provider adapter, authenticated workflow, deployment, or Tier 13 release gate is represented as supported.
- The four verification failures previously listed here are fixed, not waived: the `tooling/dev/preflight.mjs` formatting refusal, the gateway log-observation integration assertion, Playwright lifecycle teardown residue, and Linux Redis native provisioning. Each was repaired at its cause and its gate is green in run 31428413658.
- `dev:up` and `dev:down` fail closed, and therefore wedge, if an ownership record's PID has been reused by an unrelated process, until the named `.dev/pids/<service>.{pid,meta.json}` files are removed by hand. Normal shutdown no longer creates such a record; the remaining exposure is a crash or a machine-wide PID wrap. Recorded rather than auto-healed because safe recovery must distinguish an idle port from one a foreign process holds.
- Dependency records and current artifact/audit evidence exist, but PostgreSQL, Redis, Node, browser, and package rows remain release-admission pending until the explicit legal, maintenance, historical-security, platform, signature/provenance, and operational-cost reviews close.
- The current native macOS command paths and dynamic linkage are machine-specific observations, not portable artifact guarantees. CI builds exact checksummed PostgreSQL and Redis sources but does not claim bit-for-bit binary reproducibility.
- Local loopback readiness cannot establish staging or production readiness.
- Redis availability or contents can never justify a monetary authorization.
- A capability not listed with passing evidence is unsupported, not implicitly best-effort.
