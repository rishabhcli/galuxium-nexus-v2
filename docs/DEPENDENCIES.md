# Dependency Admission Register

> **Status:** The Tier 0 dependency record is explicit and regenerable: every root/workspace direct
> dependency, native tool, and managed browser artifact has its own licence, maintenance, security
> history, scripts/native, measured local footprint, exposure, provenance, and removal fields. Where
> local evidence cannot establish a conclusion, the per-row status is `undetermined`, not silently
> accepted. **Full release admission remains pending** for the live upstream, historical advisory,
> legal-obligation, platform, and runtime/bundle reviews named by each row.

## Authority and scope

[`tooling/dependencies/register.json`](../tooling/dependencies/register.json) is the normative,
machine-readable register. This document explains its policy and renders its current rows for human
review. The verifier validates the complete register against the committed Draft 2020-12 schema,
including `additionalProperties: false` boundaries and exact discriminated Node/npm/source-build
native provenance variants, before applying its semantic checks. It also runs eleven negative
mutations so a weakened schema that accepts unknown or prototype-named
dependency/review/component/provenance properties, malformed nested review/component fields, or
invalid source digests fails closed. The
verifier discovers every direct declaration in the root and locked workspace manifests; it fails on
a missing row, stale row, consumer drift, non-exact spec, lockfile mismatch, installed artifact
version mismatch, or declared-licence mismatch.

The register includes:

- external registry packages in `dependencies`, `devDependencies`, `optionalDependencies`, and
  `peerDependencies`;
- first-party workspace packages that are direct dependencies of another workspace;
- pinned Node, npm, PostgreSQL, and Redis native tool distributions; and
- the Playwright-managed Chromium, headless-shell, and FFmpeg artifacts used by browser tests.

Transitive packages are pinned by `package-lock.json`. Their exact lock metadata and the scripts,
licence files, platform selectors, binary entry points, native files, and footprints available in
the current installation are captured under `lockedGraph` in the generated metadata. A
platform-filtered optional package is never represented as inspected when its artifact is absent;
only its exact lockfile metadata is recorded.

## Regenerating and checking the evidence

Run the repository bootstrap first from a clean checkout. It uses the pinned runtime, installs the
immutable npm graph with consumer lifecycle scripts disabled, and installs the explicitly managed
Playwright Chromium target into the repository-owned cache.

```sh
node tooling/bootstrap.mjs
node tooling/run-npm.mjs test -- tooling/dependencies/*.test.mjs
node tooling/dependencies/verify.mjs
```

The standalone suites prove the same valid-register, negative-refusal, and local-path-redaction
behavior exercised inside every verifier run. The verifier re-executes itself with the
repository-pinned Node `24.18.0` and npm `11.16.0`, then regenerates the suite, writing each JSON
artifact through an atomic rename:

| Evidence                                                                          | Contents                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dependency-metadata.json`](../evidence/dependencies/dependency-metadata.json)   | Input hashes; npm/native-build supply-chain controls; manifest/register coverage; exact direct and transitive lock metadata; installed manifests, scripts, licence-file hashes, native artifacts, platform selectors, and footprint; native tool identities and paths; Playwright browser revisions, binaries, dynamic linkage, and local footprint |
| [`npm-audit-production.json`](../evidence/dependencies/npm-audit-production.json) | Sanitized, point-in-time result of `npm audit --json --ignore-scripts --omit=dev --registry=https://registry.npmjs.org/`                                                                                                                                                                                                                            |
| [`npm-audit-full.json`](../evidence/dependencies/npm-audit-full.json)             | Sanitized, point-in-time result of `npm audit --json --ignore-scripts --registry=https://registry.npmjs.org/`                                                                                                                                                                                                                                       |
| [`verification.json`](../evidence/dependencies/verification.json)                 | Output hashes, coverage/gate summary, observation timestamps, and the explicit incomplete-admission boundary                                                                                                                                                                                                                                        |

Every evidence file names its generating command and seed. The extractor is deterministic and uses
no randomized operation, so the seed is explicitly recorded as not applicable rather than invented.

CI and repeat verification use the non-mutating mode:

```sh
node tooling/dependencies/verify.mjs --check
```

`--check` repeats metadata validation, native/browser identity checks, and both live npm audits. It
also validates the committed input and output hashes and the sanitized audit result, but it does not
rewrite time-stamped evidence. It intentionally verifies current platform-specific installed
artifacts without requiring their absolute paths, dynamic linkage, or footprint to byte-match a
reference artifact produced on another platform. It does require the portable manifest, lock,
register, committed npm policy, bootstrap, pinned-runtime, native-provisioner, native-build
toolchain register, bounded-download helper, Playwright descriptor, and generator input hashes to
match. Default mode is the only evidence-regeneration command.

Generated evidence may not contain an absolute repository path or a raw Unix/macOS/Windows home
path in either an object key or value, including when embedded inside another string.
Repository-owned artifacts are repository-relative, an external artifact beneath the current
home uses the explicit `<home>/...` placeholder, and non-home platform paths such as Homebrew's
`/opt/...` remain visible as platform-specific observations. Native-linkage text is normalized by
the same policy, and both generated and committed evidence are recursively rejected on a leak.

### Secret isolation for audit commands

The verifier does not pass the parent environment to npm audit. It creates fresh repository-local
scratch home, cache, temporary, user-config, and global-config paths; pins the public npm registry;
passes an allowlisted environment only; and persists a schema-selected audit result rather than raw
stdout or stderr. No auth configuration or environment values are written to evidence. Evidence is
also rejected if it contains a secret-shaped key.

## Acceptance policy

An accepted dependency requires evidence for all of the following:

1. exact version and, for downloaded artifacts, immutable revision plus checksum/signature evidence;
2. upstream source and artifact provenance;
3. licence text for the exact artifact, notice/source obligations, and compatibility with
   distribution and hosted operation;
4. maintenance status, release cadence, end-of-life date where published, and a replacement path;
5. security history and all current advisories, with an explicit disposition for every finding;
6. consumer lifecycle scripts, native code, downloaded binaries, post-install network behavior, and
   supported platforms;
7. production runtime, cold-start, memory, image, browser-bundle, install, and operational cost
   where applicable;
8. owning workspace, trust boundary, and removal seam; and
9. regenerating command and immutable evidence path.

Exact pins are mandatory. Lifecycle scripts are denied during `npm ci`; a necessary downloaded
artifact must instead cross an explicit, versioned bootstrap boundary. Native binaries require
platform, provenance, checksum/signature, linkage, and failure-mode review. Runtime/provider SDKs
stay behind adapters, and domain packages may not import transport or framework state.

No unresolved critical or high-severity vulnerability is acceptable. Lower-severity findings need a
documented reachability and impact disposition. An audit with zero returned advisories is only a
time-stamped current-advisory observation; it is not proof that a package has no security history or
will remain safe.

## Direct dependency rows

The following is a human rendering of every unique direct dependency. Exact consumer arrays are in
the machine register and are checked against all manifests on every run.

Every row below has its own `review` object and removal boundary in the machine register. In those
per-row records:

- the exact artifact-declared licence and top-level licence/notice file hashes are generated, but
  legal obligations have not been reviewed;
- maintenance is explicitly `undetermined-from-local-artifact`; the exact lockfile deprecation
  marker (including explicit `null`) and installed manifest repository metadata are recorded, but no
  active/inactive conclusion is fabricated;
- security records the current full and production-omit-dev npm audit observations plus the explicit
  fact that historical status is undetermined; the observations are time-sensitive and must be read
  with their `completedAt` timestamps;
- exact package scripts, consumer lifecycle scripts, binary/native indicators, transitive closure
  implications, and a package-specific summary are generated; and
- installed artifact/closure bytes and file counts are measured on the evidence platform, while
  browser-bundle, cold-start, memory, and production runtime costs remain explicitly unmeasured.

| Dependency                         | Exact version / kind | Consumers                                          | Artifact-declared licence | Exposure and purpose                                                       | Admission                            |
| ---------------------------------- | -------------------: | -------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `@axe-core/playwright`             |    `4.12.1` registry | root test toolchain                                | `MPL-2.0`                 | Development test: accessibility assertions at the Playwright boundary      | **Tier 0 recorded; release pending** |
| `@eslint/js`                       |    `10.0.1` registry | root build toolchain                               | `MIT`                     | Development build: core JavaScript lint rules                              | **Tier 0 recorded; release pending** |
| `@galuxium-nexus-v2/ledger`        |    `0.1.0` workspace | gateway, reconciler                                | No `license` field        | Server runtime: first-party authoritative ledger capability                | **Tier 0 recorded; release pending** |
| `@galuxium-nexus-v2/observability` |    `0.1.0` workspace | admin, fake provider, gateway, metrics, reconciler | No `license` field        | Server runtime: first-party structured telemetry and redaction             | **Tier 0 recorded; release pending** |
| `@playwright/test`                 |    `1.62.1` registry | root test toolchain                                | `Apache-2.0`              | Development test: browser end-to-end and user-outcome runner               | **Tier 0 recorded; release pending** |
| `@types/node`                      |   `24.13.3` registry | root build toolchain                               | `MIT`                     | Development build: Node API declarations                                   | **Tier 0 recorded; release pending** |
| `@types/pg`                        |    `8.21.0` registry | root build toolchain                               | `MIT`                     | Development build: PostgreSQL client declarations                          | **Tier 0 recorded; release pending** |
| `@vitest/coverage-v8`              |    `4.1.10` registry | root test toolchain                                | `MIT`                     | Development test: V8 coverage collection and reporting                     | **Tier 0 recorded; release pending** |
| `@vitest/eslint-plugin`            |    `1.6.26` registry | root build toolchain                               | `MIT`                     | Development build: static test-convention enforcement                      | **Tier 0 recorded; release pending** |
| `dependency-cruiser`               |    `18.1.1` registry | root build toolchain                               | `MIT`                     | Development build: fail-closed ownership/import boundaries                 | **Tier 0 recorded; release pending** |
| `eslint`                           |    `10.8.1` registry | root build toolchain                               | `MIT`                     | Development build: repository static-analysis runner                       | **Tier 0 recorded; release pending** |
| `eslint-plugin-playwright`         |    `2.11.0` registry | root build toolchain                               | `MIT`                     | Development build: Playwright safety/reliability lint rules                | **Tier 0 recorded; release pending** |
| `fast-check`                       |     `4.9.0` registry | root test toolchain                                | `MIT`                     | Development test: seeded property/state-machine inputs                     | **Tier 0 recorded; release pending** |
| `globals`                          |    `17.9.0` registry | root build toolchain                               | `MIT`                     | Development build: explicit lint runtime globals                           | **Tier 0 recorded; release pending** |
| `pg`                               |    `8.23.0` registry | ledger package                                     | `MIT`                     | Server runtime: PostgreSQL protocol client at the persistence boundary     | **Tier 0 recorded; release pending** |
| `prettier`                         |     `3.9.6` registry | root build toolchain                               | `MIT`                     | Development build: deterministic formatting                                | **Tier 0 recorded; release pending** |
| `redis`                            |     `6.2.0` registry | gateway, reconciler                                | `MIT`                     | Server runtime: deny-safe cache/coordination protocol client               | **Tier 0 recorded; release pending** |
| `typescript`                       |     `6.0.3` registry | root build toolchain                               | `Apache-2.0`              | Development build: strict compiler/project-reference engine                | **Tier 0 recorded; release pending** |
| `typescript-eslint`                |    `8.66.0` registry | root build toolchain                               | `MIT`                     | Development build: type-aware parser and lint integration                  | **Tier 0 recorded; release pending** |
| `vite`                             |     `8.2.1` registry | root test toolchain                                | `MIT`                     | Development test: Vitest transform and bundling infrastructure             | **Tier 0 recorded; release pending** |
| `vitest`                           |    `4.1.10` registry | root test toolchain                                | `MIT`                     | Development test: unit and property runner                                 | **Tier 0 recorded; release pending** |
| `zod`                              |     `4.4.3` registry | observability, fake provider, gateway, reconciler  | `MIT`                     | Server runtime: validation at service/config/provider/telemetry boundaries | **Tier 0 recorded; release pending** |

## Native tool and managed artifact rows

Exact normalized command path, resolved path, version output, file size, SHA-256, and dynamic
linkage where supported are regenerated per platform. Repository paths are relative, external home
paths are redacted as described above, and `/opt` or equivalent external paths remain explicit.
Those paths are time-sensitive observations, not portable claims.

The PostgreSQL and Redis source URLs, checksums, and build flags apply to the committed CI
provisioner. A local Homebrew or other platform command is identified by its own path, version,
hash, linkage, prefix footprint, and top-level licence files; the evidence does not claim that such
a local command was built from the CI archive. The hashed native-build toolchain register records
the exact commands whose versions CI prints and explicitly says that compiler, linker, libc, and
runner-image revisions are not pinned, so source-archive verification is not a bit-for-bit compiled
binary reproducibility claim.

| Dependency                         |                                                                                                                Exact target | Role / binary implications                                                                                                                                                                               | Removal boundary                                                                                                                                                         | Admission                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Node.js                            |                                                                                                                   `24.18.0` | Pinned native runtime artifact with archive URL/SHA-256 enforced by bootstrap; executable bytes/hash and dynamic linkage recorded                                                                        | Replace the runtime wrapper, engines/package-manager contract, CI runtime, and every release artifact together                                                           | **Tier 0 recorded; release review pending** |
| npm CLI                            |                                                                                                                   `11.16.0` | Pinned JavaScript CLI inside the verified Node artifact; dependency graph, explicit scripts, bytes/hash, and audit boundary recorded                                                                     | Replace lockfile/package-manager semantics and all task/bootstrap commands together                                                                                      | **Tier 0 recorded; release review pending** |
| PostgreSQL native distribution     |                                                                                                                     `16.14` | Source URL/SHA-256/build flags plus `postgres`, `pg_ctl`, `initdb`, `psql`, `pg_isready`, and `createdb` native identities recorded                                                                      | Replace the authoritative ledger datastore only through a ledger schema/isolation/migration ADR and gate re-proof                                                        | **Tier 0 recorded; release review pending** |
| Redis native distribution          |                                                                                                                    `8.10.0` | Source URL/SHA-256/build flags plus `redis-server` and `redis-cli` identities recorded; Redis is never monetary authority                                                                                | Remove cache/coordination use or replace behind the deny-safe coordination boundary                                                                                      | **Tier 0 recorded; release review pending** |
| Playwright-managed Chromium family | manager `1.62.1`; Chromium revision `1234`, browser `151.0.7922.34`; headless-shell revision `1234`; FFmpeg revision `1011` | Downloaded native browser, renderer/helper processes, shared libraries, and media binary under `.dev/cache/playwright`; executable hashes, linkage, notices/markers, and platform footprint are recorded | Remove Playwright/axe dependencies, E2E/accessibility suites and configuration, and the explicit bootstrap install; no production/domain package may import the artifact | **Tier 0 recorded; release review pending** |

The Playwright descriptor at `node_modules/playwright-core/browsers.json` is hashed as a primary
local artifact and checked against the register. The verifier asks the exactly locked Playwright
manager for the executable path, requires it to remain inside `.dev/cache/playwright`, checks its
reported browser version, and hashes the installed executable/native/notice/marker files. The cache
is platform-specific and is never committed.

The Redis native row has one explicit upstream security-history disposition. The official
[Redis 8.8.1 release](https://github.com/redis/redis/releases/tag/8.8.1) classified crafted
RedisBloom and TDigest `RESTORE` payload out-of-bounds writes, with potential remote code execution,
as a security fix. The merged official
[RedisBloom 8.10 update](https://github.com/RedisBloom/RedisBloom/pull/1048) records that
RDB/`RESTORE` hardening in RedisBloom v8.10.0 before the official
[Redis 8.10.0 GA release](https://github.com/redis/redis/releases/tag/8.10.0). The repository moved
from the superseded 8.8.0 target to exact 8.10.0. This dispositions that discovered issue only; it
does not claim a complete native advisory history or predict future status.

## Current advisory observation boundary

The committed audit evidence currently records zero returned vulnerabilities for both the full
locked graph and the `--omit=dev` invocation. That sentence is valid **only at each artifact's exact
`audit.completedAt` timestamp and for its hashed `package-lock.json` input**. Regenerate or run
`--check` before making a later security statement. The evidence deliberately does not claim:

- that any dependency has no historical vulnerability;
- that an advisory database is complete;
- that an absent advisory proves non-reachability or safety;
- that a package is actively maintained; or
- that the next audit will return the same result.

## Remaining admission work

Before changing any row to admitted, review and record the exact upstream source/provenance,
maintenance/support window, historical advisories, exact licence and notice obligations, supported
platforms, failure/cancellation behavior, replacement exercise, and applicable cold-start, memory,
bundle, install, and operational costs. Set real review and refresh timestamps. Never infer those
conclusions from a package name, recent version number, successful install, or zero-result audit.
