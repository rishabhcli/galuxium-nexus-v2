-- 0001_double_entry_ledger
--
-- The authoritative monetary schema. Every constraint here exists because an
-- application-level check is not enough: this database is reachable from more
-- than one process, and a bug, a partial deploy, or a future service must not be
-- able to write a state the domain forbids. Where a domain invariant can be
-- expressed as a constraint, it is expressed as a constraint.
--
-- Naming: `ledger` schema, so a future unrelated table cannot collide with a
-- monetary one and so grants can be given per schema.

CREATE SCHEMA IF NOT EXISTS ledger;

-- The nanodollar magnitude bound. Identical to MAX_NANODOLLARS in
-- packages/ledger/src/money.ts. Both ends exist because entries are signed in
-- aggregate even though every individual amount is positive.
CREATE DOMAIN ledger.nanodollars AS NUMERIC(38, 0) CHECK (
  VALUE >= -1000000000000000000000000 AND VALUE <= 1000000000000000000000000
);

CREATE DOMAIN ledger.nonnegative_nanodollars AS NUMERIC(38, 0) CHECK (
  VALUE >= 0 AND VALUE <= 1000000000000000000000000
);

CREATE DOMAIN ledger.positive_nanodollars AS NUMERIC(38, 0) CHECK (
  VALUE > 0 AND VALUE <= 1000000000000000000000000
);

-- Matches the PRICE_BOOK_VERSION pattern in packages/ledger/src/identity.ts.
CREATE DOMAIN ledger.price_book_version AS TEXT CHECK (
  VALUE ~ '^\d{4}-\d{2}-\d{2}\.(0|[1-9]\d{0,3})$'
);

CREATE TABLE ledger.tenants (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT tenants_disabled_at_matches_status CHECK (
    (status = 'disabled') = (disabled_at IS NOT NULL)
  )
);

-- Immutable by policy and by grant: the version that authorized an attempt must
-- still mean the same thing years later (invariant I5). Nothing in this schema
-- references a price book row with ON DELETE CASCADE, and the runtime role is
-- granted INSERT and SELECT only, never UPDATE or DELETE.
CREATE TABLE ledger.price_book_versions (
  version ledger.price_book_version PRIMARY KEY,
  published_at TIMESTAMPTZ NOT NULL,
  -- Rates keyed by provider and model. Read as untrusted input on the way out:
  -- a JSONB column cannot express the domain's rate type.
  rates JSONB NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

-- Double-entry accounts. Exactly one of each kind per tenant, so a movement can
-- always name its two sides without a lookup that might return nothing.
--
--   funding                 external credit source; the counter-party for a top-up
--   available               spendable, unreserved balance
--   reserved                held against an open or unresolved attempt
--   settled                 spend that actually occurred and was authorized
--   unreconciled_overspend  spend a provider reported after resolution
--
-- The last one is the honest home for money that left without a live
-- authorization to charge. See "Scope of the spend guarantee" in
-- SUPPORT_MATRIX.md: it keeps the ledger balanced and keeps invariant I2 true
-- without pretending the cost did not happen.
CREATE TABLE ledger.accounts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES ledger.tenants (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (
    kind IN ('funding', 'available', 'reserved', 'settled', 'unreconciled_overspend')
  ),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT accounts_one_per_kind_per_tenant UNIQUE (tenant_id, kind),
  -- Referenced by the composite foreign keys below, which is how a cross-tenant
  -- entry becomes unrepresentable rather than merely rejected in review.
  CONSTRAINT accounts_tenant_scoped_identity UNIQUE (id, tenant_id)
);

-- The hot row. One per tenant, updated in the same transaction as the ledger
-- entry it accounts for, never in a separate write.
--
-- `budgets_available_never_negative` is invariant I2, enforced by PostgreSQL
-- rather than by the application. No interleaving of concurrent reservations,
-- no retry storm, and no application defect can commit a state where a tenant
-- has authorized more than it funded: the transaction fails instead.
--
-- Read the scope of that guarantee precisely: the constraint holds over one ROW.
-- It is the invariant only because all three columns are mutated together by a
-- single-row UPDATE, which is also what serialises concurrent reservations for
-- one tenant. If a future change ever moves reserved_nanodollars into a child
-- table, or maintains it from more than one statement, this check silently
-- stops being I2 and becomes a per-row sanity check. Sharding the hot row for
-- throughput -- the option WINNING_IDEA.md leaves open -- is exactly that
-- change, and it must not be made without replacing this constraint with one
-- of equal strength over the shard set.
CREATE TABLE ledger.budgets (
  tenant_id UUID PRIMARY KEY REFERENCES ledger.tenants (id) ON DELETE RESTRICT,
  credited_nanodollars ledger.nonnegative_nanodollars NOT NULL,
  settled_nanodollars ledger.nonnegative_nanodollars NOT NULL,
  reserved_nanodollars ledger.nonnegative_nanodollars NOT NULL,
  overspend_nanodollars ledger.nonnegative_nanodollars NOT NULL,
  -- Injected when a client omits max_tokens. Without this the worst-case bound
  -- becomes the model's whole context window and one request reserves the entire
  -- budget, which makes the product useless. See WINNING_IDEA.md.
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0 AND max_output_tokens <= 100000000),
  reservation_ttl_seconds INTEGER NOT NULL CHECK (
    reservation_ttl_seconds > 0 AND reservation_ttl_seconds <= 86400
  ),
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT budgets_available_never_negative CHECK (
    credited_nanodollars - settled_nanodollars - reserved_nanodollars >= 0
  )
);

-- One reservation per authorized attempt.
--
-- `reservations_status_shape` is invariants I3 and I4 as a single constraint: a
-- non-terminal reservation has settled nothing and released nothing, and a
-- terminal one has partitioned its reserved amount into exactly one settled part
-- and one released part that sum back to it. An imbalanced terminal row cannot
-- exist, so "the ledger balances" is not a property the application maintains.
CREATE TABLE ledger.reservations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  attempt_id UUID NOT NULL UNIQUE,
  -- Caller-supplied. The unit of exactly-once admission: a retried request with
  -- the same key finds the existing reservation instead of creating a second one.
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- Invariant I5. RESTRICT, never CASCADE: a price book row that an attempt
  -- depends on can never be deleted out from under it.
  price_book_version ledger.price_book_version NOT NULL REFERENCES ledger.price_book_versions (version) ON DELETE RESTRICT,
  reserved_nanodollars ledger.positive_nanodollars NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('open', 'dispatched', 'uncertain', 'settled', 'released', 'adjusted')
  ),
  fence BIGINT NOT NULL CHECK (fence >= 1 AND fence <= 4611686018427387904),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  settled_nanodollars NUMERIC(38, 0),
  released_nanodollars NUMERIC(38, 0),
  release_reason TEXT CHECK (
    release_reason IN (
      'client_cancelled_before_dispatch',
      'expired_before_dispatch',
      'provider_refused_before_usage',
      'reconciled_zero_usage'
    )
  ),
  uncertain_reason TEXT CHECK (
    uncertain_reason IN (
      'expiry_without_outcome',
      'provider_stream_interrupted',
      'provider_timeout',
      'provider_unparseable_response'
    )
  ),
  adjustment_actor TEXT,
  adjustment_ticket TEXT,
  adjustment_reason TEXT,
  CONSTRAINT reservations_tenant_scoped_key UNIQUE (tenant_id, id),
  CONSTRAINT reservations_idempotent_per_tenant UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT reservations_tenant_exists FOREIGN KEY (tenant_id) REFERENCES ledger.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT reservations_expire_after_creation CHECK (expires_at > created_at),
  CONSTRAINT reservations_status_shape CHECK (
    CASE status
      WHEN 'open' THEN
        dispatched_at IS NULL
        AND settled_nanodollars IS NULL
        AND released_nanodollars IS NULL
        AND release_reason IS NULL
        AND uncertain_reason IS NULL
        AND resolved_at IS NULL
      WHEN 'dispatched' THEN
        dispatched_at IS NOT NULL
        AND settled_nanodollars IS NULL
        AND released_nanodollars IS NULL
        AND release_reason IS NULL
        AND uncertain_reason IS NULL
        AND resolved_at IS NULL
      WHEN 'uncertain' THEN
        settled_nanodollars IS NULL
        AND released_nanodollars IS NULL
        AND release_reason IS NULL
        AND uncertain_reason IS NOT NULL
        AND observed_at IS NOT NULL
        AND resolved_at IS NULL
      WHEN 'settled' THEN
        dispatched_at IS NOT NULL
        AND settled_nanodollars IS NOT NULL
        AND released_nanodollars IS NOT NULL
        AND settled_nanodollars >= 0
        AND released_nanodollars >= 0
        AND settled_nanodollars + released_nanodollars = reserved_nanodollars
        AND release_reason IS NULL
        AND resolved_at IS NOT NULL
      WHEN 'released' THEN
        settled_nanodollars = 0
        AND released_nanodollars = reserved_nanodollars
        AND release_reason IS NOT NULL
        AND resolved_at IS NOT NULL
      WHEN 'adjusted' THEN
        settled_nanodollars IS NOT NULL
        AND released_nanodollars IS NOT NULL
        AND settled_nanodollars >= 0
        AND released_nanodollars >= 0
        AND settled_nanodollars + released_nanodollars = reserved_nanodollars
        AND uncertain_reason IS NOT NULL
        AND adjustment_actor IS NOT NULL
        AND adjustment_ticket IS NOT NULL
        AND adjustment_reason IS NOT NULL
        AND resolved_at IS NOT NULL
      ELSE FALSE
    END
  )
);

CREATE INDEX reservations_expiry_sweep
  ON ledger.reservations (expires_at)
  WHERE status IN ('open', 'dispatched');

CREATE INDEX reservations_unresolved_by_tenant
  ON ledger.reservations (tenant_id, status)
  WHERE status IN ('open', 'dispatched', 'uncertain');

-- One row is one balanced movement: a debit of one account and a credit of
-- another, of the same amount.
--
-- Note the deviation from the textbook shape, because a reviewer will look for
-- the thing that is deliberately absent. Classical double entry writes two
-- rows and then needs a constraint tying them into a balanced pair -- a
-- sum-to-zero check over a group, which PostgreSQL cannot express
-- declaratively and which therefore becomes a trigger or application
-- discipline. Carrying both sides on one row removes the failure mode instead:
-- there is no way to write half a movement, no group to validate, and the sum
-- over every account is zero by construction. An account balance is
-- sum(credited) - sum(debited), and I4's balanced half needs no enforcement
-- because it has no way to fail.
CREATE TABLE ledger.entries (
  id UUID PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id UUID NOT NULL,
  debit_account_id UUID NOT NULL,
  credit_account_id UUID NOT NULL,
  amount_nanodollars ledger.positive_nanodollars NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'credit_funding',
      'reserve_hold',
      'settle_reserved',
      'release_reserved',
      'compensate_unreconciled_overspend',
      'manual_adjustment'
    )
  ),
  reservation_id UUID,
  -- Deliberately nullable: a funding credit precedes every attempt and has no
  -- authorizing price book version. `entries_price_version_recorded_for_attempt_kinds`
  -- below makes null exactly co-extensive with `credit_funding`.
  price_book_version ledger.price_book_version,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT entries_two_distinct_sides CHECK (debit_account_id <> credit_account_id),
  -- Composite: an entry cannot name an account belonging to another tenant, at
  -- the storage layer, underneath row-level security rather than instead of it.
  CONSTRAINT entries_debit_account_is_tenant_scoped FOREIGN KEY (debit_account_id, tenant_id)
    REFERENCES ledger.accounts (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT entries_credit_account_is_tenant_scoped FOREIGN KEY (credit_account_id, tenant_id)
    REFERENCES ledger.accounts (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT entries_reservation_is_tenant_scoped FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES ledger.reservations (tenant_id, id) ON DELETE RESTRICT,
  -- Invariant I4's idempotent half. A settle or release for a reservation can be
  -- written exactly once; a retried settlement violates this and is recognised
  -- as an already-applied no-op instead of moving money twice.
  CONSTRAINT entries_one_per_reservation_kind UNIQUE (reservation_id, kind),
  CONSTRAINT entries_reservation_required_for_attempt_kinds CHECK (
    (kind = 'credit_funding') = (reservation_id IS NULL)
  ),
  CONSTRAINT entries_price_version_recorded_for_attempt_kinds CHECK (
    (kind = 'credit_funding') = (price_book_version IS NULL)
  )
);

CREATE INDEX entries_by_tenant_sequence ON ledger.entries (tenant_id, sequence DESC);
CREATE INDEX entries_by_reservation ON ledger.entries (reservation_id) WHERE reservation_id IS NOT NULL;

-- Append-only record of every change an operator made to a limit, a policy, or a
-- reservation's accounting. Separate from `entries` because an audit event is not
-- a movement of money and must survive even when it moved none.
CREATE TABLE ledger.audit_events (
  id UUID PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id UUID REFERENCES ledger.tenants (id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
  action TEXT NOT NULL CHECK (
    action IN (
      'tenant_created',
      'tenant_disabled',
      'budget_limit_changed',
      'budget_credited',
      'manual_adjustment_applied',
      'kill_switch_engaged',
      'kill_switch_released',
      'imbalance_detected'
    )
  ),
  reservation_id UUID,
  ticket TEXT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2048),
  -- Bounded, non-secret context only. Never a prompt, a completion, or a key.
  detail JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT audit_manual_adjustment_carries_a_ticket CHECK (
    (action <> 'manual_adjustment_applied') OR (ticket IS NOT NULL AND reservation_id IS NOT NULL)
  )
);

CREATE INDEX audit_events_by_tenant_sequence ON ledger.audit_events (tenant_id, sequence DESC);

-- Row-level security. Defence in depth: application query scoping, the composite
-- foreign keys above, and these policies all have to be wrong simultaneously for
-- one tenant to read another's money.
--
-- Scoping reads `app.tenant_id`, which the gateway sets per request on the
-- connection it is about to use. `current_setting(..., true)` returns NULL when
-- the setting is absent, and NULL never equals a tenant id, so an unscoped
-- connection sees zero rows rather than all of them. Failing to set the scope
-- therefore breaks loudly on the first query instead of quietly returning
-- everything.
--
-- RLS is enabled but deliberately not FORCEd. The table owner
-- (`galuxium_nexus_v2_owner`) is the migration and system identity and must be
-- able to run the cross-tenant invariant checker and the reconciler sweep; the
-- runtime role (`galuxium_nexus_v2`) is NOBYPASSRLS, holds no owner-role
-- membership, and is the only identity application processes are given, so no
-- request path can reach the unscoped view. See ASSUMPTIONS.md.
ALTER TABLE ledger.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.audit_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION ledger.current_tenant_id() RETURNS UUID
  LANGUAGE sql
  STABLE
  -- No search_path dependency and no table access, so it cannot be redirected by
  -- a caller-controlled search_path.
  SET search_path = pg_catalog
  AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::UUID
  $$;

CREATE POLICY tenants_scoped ON ledger.tenants
  USING (id = ledger.current_tenant_id())
  WITH CHECK (id = ledger.current_tenant_id());

CREATE POLICY accounts_scoped ON ledger.accounts
  USING (tenant_id = ledger.current_tenant_id())
  WITH CHECK (tenant_id = ledger.current_tenant_id());

CREATE POLICY budgets_scoped ON ledger.budgets
  USING (tenant_id = ledger.current_tenant_id())
  WITH CHECK (tenant_id = ledger.current_tenant_id());

CREATE POLICY reservations_scoped ON ledger.reservations
  USING (tenant_id = ledger.current_tenant_id())
  WITH CHECK (tenant_id = ledger.current_tenant_id());

CREATE POLICY entries_scoped ON ledger.entries
  USING (tenant_id = ledger.current_tenant_id())
  WITH CHECK (tenant_id = ledger.current_tenant_id());

CREATE POLICY audit_events_scoped ON ledger.audit_events
  USING (tenant_id = ledger.current_tenant_id())
  WITH CHECK (tenant_id = ledger.current_tenant_id());

-- The runtime role's privileges, enumerated rather than granted wholesale.
--
-- No UPDATE and no DELETE on `entries`, `audit_events`, or
-- `price_book_versions`: those three are append-only, and append-only enforced
-- by grant is stronger than append-only enforced by the code that writes them.
-- No DELETE anywhere at all — nothing in this domain is ever deleted.
GRANT USAGE ON SCHEMA ledger TO galuxium_nexus_v2;
GRANT EXECUTE ON FUNCTION ledger.current_tenant_id() TO galuxium_nexus_v2;
GRANT SELECT, INSERT, UPDATE ON ledger.tenants TO galuxium_nexus_v2;
GRANT SELECT, INSERT ON ledger.accounts TO galuxium_nexus_v2;
GRANT SELECT, INSERT, UPDATE ON ledger.budgets TO galuxium_nexus_v2;
GRANT SELECT, INSERT, UPDATE ON ledger.reservations TO galuxium_nexus_v2;
GRANT SELECT, INSERT ON ledger.entries TO galuxium_nexus_v2;
GRANT SELECT, INSERT ON ledger.audit_events TO galuxium_nexus_v2;
GRANT SELECT, INSERT ON ledger.price_book_versions TO galuxium_nexus_v2;
