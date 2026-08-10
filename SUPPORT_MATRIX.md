# Support Matrix

> **Current status:** Not yet in production. Tier 0 local-foundation work is in progress and has partial current-machine evidence on macOS arm64; security hardening, final clean-checkout, and GitHub Actions evidence remain pending. No row below promotes a local development result into product, release, staging, or production support.

An entry becomes **Supported** only when a committed command reproduces its acceptance evidence from a clean checkout. A design decision, installed tool, build result, or local smoke test is not enough. Unknown combinations fail closed and must not be presented as degraded-but-supported behavior.

| Surface | Intended boundary | Current status | Required evidence before support |
|---|---|---|---|
| Node.js runtime | Exact `24.18.0` LTS | Implemented; checksummed repository-local darwin-arm64 bootstrap and mismatch refusals pass; clean-checkout/CI support pending | Final clean-checkout build/test, Linux CI run, runtime and deployment matrix |
| npm CLI | Exact `11.16.0` with npm workspaces and committed lockfile | Implemented locally; immutable lifecycle-disabled bootstrap and mismatch refusal pass; release admission pending | Final clean-checkout bootstrap, lock/evidence agreement, Linux CI run, dependency review closure |
| TypeScript | Exact `6.0.3`, strict shared compiler contract | Implemented locally; all-workspace typecheck and negative import-boundary fixture pass; clean-checkout support pending | Final clean-checkout verifier and Linux CI run |
| Local PostgreSQL | Native PostgreSQL `16.14` process owned by this repository, all mutable state under `.dev/`, loopback port 4165, database/runtime role `galuxium_nexus_v2`, distinct owner `galuxium_nexus_v2_owner` | Implemented and current-machine health-verified for development only; backup/restore and production use unsupported | Clean-checkout lifecycle/CI; native admission closure; schema migration, backup, restore, failover, load, and tenant-isolation evidence |
| Local Redis | Native Redis `8.10.0` process owned by this repository, all mutable state under `.dev/`, loopback port 4166, exact URL and logical DB 6; never monetary authority | Security-patch upgrade implemented; current-machine lifecycle re-verification pending; release admission pending | Exact rebuilt lifecycle health, clean-checkout lifecycle/CI, native admission closure, outage/failover and cache-denial property evidence |
| Local HTTP services | Compiled Node processes bound only to `127.0.0.1` on ports 4160, 4161, 4162, 4163, and 4167 | Implemented and current-machine health-verified; product behavior is intentionally unavailable | Clean-checkout verifier/CI plus later authentication, authorization, rate/concurrency, resilience, and product-outcome evidence |
| Deterministic fake provider | Local/test deterministic usage and explicit failure injection only | Implemented and locally contract-tested; startup requires development configuration; unsupported as a production provider or fallback | Final clean-checkout contract/E2E evidence and continuing proof that no production fallback path exists |
| Admin browser support | Playwright-managed Chromium 151.0.7922.34 revision 1234 on the current macOS arm64 evidence machine only | Keyboard/semantic and axe critical/serious checks pass locally; no cross-browser or production support declared | Clean-checkout/CI Chromium run plus screen-reader, contrast, reduced-motion, zoom/reflow, WebKit/Firefox, and manual evidence |
| Provider APIs | No real provider/model/version declared | Unsupported | Versioned adapter contract, real integration and reconciliation tests, provenance and failure matrix |
| Production deployment | No cloud, region, domain, topology, or public release declared | Unsupported; production has not occurred | Full production criteria, deployment/rollback evidence, health/SLOs, soak, real use, incident and restore drills |
| Staging | No environment declared | Unsupported | Production-shaped deployment with synthetic/de-identified data, observability, rollback, and side-effect policy |
| Operating systems and CPU architectures | Current development evidence: macOS arm64; intended CI: GitHub-hosted Ubuntu 24.04 x64 with runner-specific source builds | macOS arm64 local foundation observed only; Linux workflow unexecuted; every other combination unsupported | Passing clean-checkout evidence on each declared platform; exact native/browser linkage and limitations; production artifact matrix |
| External side effects | Disabled unless a future typed policy explicitly authorizes one | Unsupported by default | Threat analysis, preview/policy authorization, idempotency, audit, cancellation, and reconciliation tests |

## Known limitations

- The local status page and readiness APIs are foundation diagnostics, not the canonical budget-control user workflow. No budget API, monetary schema, provider adapter, authenticated workflow, deployment, or Tier 13 release gate is represented as supported.
- Dependency records and current artifact/audit evidence exist, but PostgreSQL, Redis, Node, browser, and package rows remain release-admission pending until the explicit legal, maintenance, historical-security, platform, signature/provenance, and operational-cost reviews close.
- The current native macOS command paths and dynamic linkage are machine-specific observations, not portable artifact guarantees. CI builds exact checksummed PostgreSQL and Redis sources but does not claim bit-for-bit binary reproducibility.
- Local loopback readiness cannot establish staging or production readiness.
- Redis availability or contents can never justify a monetary authorization.
- A capability not listed with passing evidence is unsupported, not implicitly best-effort.
