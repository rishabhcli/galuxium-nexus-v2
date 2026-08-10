import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { admitProviderDispatch } from '../src/admission.js';
import {
  accountId,
  attemptId,
  fenceToken,
  priceBookVersion,
  reservationId,
  tenantId,
  tenantScope,
} from '../src/identity.js';
import { positiveNanodollars } from '../src/money.js';
import {
  type DispatchAuthorization,
  type DispatchedReservation,
  type OpenReservation,
  type ReservationState,
  type TransitionOutcome,
  applyReservationEvent,
} from '../src/reservation.js';
import { instantUtc } from '../src/time.js';
import { attempt, refuses, returns } from './support/outcome.js';

const TENANT = tenantId('99999999-8888-4777-8666-555544443333');
const OTHER_TENANT = tenantId('12121212-3434-4565-8787-989898989898');
const SCOPE = tenantScope(TENANT);
const OTHER_SCOPE = tenantScope(OTHER_TENANT);
const FENCE = fenceToken(7n);
const RESERVED = positiveNanodollars(500_000_000n);
const AT = instantUtc(1_786_000_000_000_000n);
const PRICE_VERSION = priceBookVersion('2026-08-10.1');

function openReservation(): OpenReservation {
  return {
    accountId: accountId('3f8b1c22-4d5e-4f60-8a71-9b2c3d4e5f60'),
    attemptId: attemptId('11111111-2222-4333-8444-555555555555'),
    expiresAt: instantUtc(AT + 30_000_000n),
    fence: FENCE,
    priceBookVersion: PRICE_VERSION,
    reservationId: reservationId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    reservedAmount: RESERVED,
    status: 'open',
    tenantId: TENANT,
  };
}

function applied(outcome: TransitionOutcome): Extract<TransitionOutcome, { outcome: 'applied' }> {
  if (outcome.outcome !== 'applied') {
    throw new Error(`expected an applied transition, received ${outcome.outcome}`);
  }
  return outcome;
}

function dispatched(): { authorization: DispatchAuthorization; state: DispatchedReservation } {
  const outcome = applied(
    applyReservationEvent(openReservation(), { at: AT, fence: FENCE, kind: 'dispatch' }),
  );
  if (outcome.authorization === undefined || outcome.state.status !== 'dispatched') {
    throw new Error('dispatching an open reservation must yield an authorization');
  }
  return { authorization: outcome.authorization, state: outcome.state };
}

describe('I1 at the runtime boundary: a committed dispatched reservation is required', () => {
  it('admits the authorization the state machine produced', () => {
    const { authorization, state } = dispatched();
    expect(attempt(() => admitProviderDispatch(authorization, state, SCOPE))).toStrictEqual(
      returns(authorization),
    );
  });

  it('refuses a dispatch against a reservation in any non-dispatched state', () => {
    const { authorization } = dispatched();
    const open = openReservation();
    const settled = applied(
      applyReservationEvent(dispatched().state, {
        at: AT,
        fence: FENCE,
        kind: 'observe_usage',
        settledAmount: positiveNanodollars(1n),
      }),
    ).state;
    const released = applied(
      applyReservationEvent(open, { at: AT, fence: FENCE, kind: 'expire' }),
    ).state;

    const persisted = [open, settled, released];
    expect(
      persisted.map((record) => attempt(() => admitProviderDispatch(authorization, record, SCOPE))),
    ).toStrictEqual(persisted.map(() => refuses('DISPATCH_ADMISSION_RESERVATION_NOT_DISPATCHED')));
  });

  it('refuses a superseded fencing token', () => {
    const { authorization, state } = dispatched();
    expect(
      attempt(() =>
        admitProviderDispatch({ ...authorization, fence: fenceToken(FENCE + 1n) }, state, SCOPE),
      ),
    ).toStrictEqual(refuses('DISPATCH_ADMISSION_FENCE_STALE'));
  });

  it('refuses a cross-tenant dispatch from either side of the comparison (I7)', () => {
    const { authorization, state } = dispatched();
    expect(attempt(() => admitProviderDispatch(authorization, state, OTHER_SCOPE))).toStrictEqual(
      refuses('DISPATCH_ADMISSION_SCOPE_MISMATCH'),
    );
    expect(
      attempt(() =>
        admitProviderDispatch(
          { ...authorization, tenantId: OTHER_TENANT },
          { ...state, tenantId: OTHER_TENANT },
          SCOPE,
        ),
      ),
    ).toStrictEqual(refuses('DISPATCH_ADMISSION_SCOPE_MISMATCH'));
  });

  it('refuses an authorization naming a different reservation or attempt', () => {
    const { authorization, state } = dispatched();
    expect(
      attempt(() =>
        admitProviderDispatch(
          {
            ...authorization,
            reservationId: reservationId('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'),
          },
          state,
          SCOPE,
        ),
      ),
    ).toStrictEqual(refuses('DISPATCH_ADMISSION_IDENTITY_MISMATCH'));
    expect(
      attempt(() =>
        admitProviderDispatch(
          { ...authorization, attemptId: attemptId('22222222-3333-4444-8555-666666666666') },
          state,
          SCOPE,
        ),
      ),
    ).toStrictEqual(refuses('DISPATCH_ADMISSION_IDENTITY_MISMATCH'));
  });

  it('refuses a price book version that disagrees with the record (I5)', () => {
    const { authorization, state } = dispatched();
    expect(
      attempt(() =>
        admitProviderDispatch(
          { ...authorization, priceBookVersion: priceBookVersion('2026-08-09.1') },
          state,
          SCOPE,
        ),
      ),
    ).toStrictEqual(refuses('DISPATCH_ADMISSION_PRICE_VERSION_MISMATCH'));
  });

  it('refuses a chargeable amount that does not match the held reservation', () => {
    const { authorization, state } = dispatched();
    const amounts = [RESERVED + 1n, RESERVED - 1n];
    expect(
      amounts.map((amount) =>
        attempt(() =>
          admitProviderDispatch(
            { ...authorization, maximumChargeableAmount: positiveNanodollars(amount) },
            state,
            SCOPE,
          ),
        ),
      ),
    ).toStrictEqual(amounts.map(() => refuses('DISPATCH_ADMISSION_AMOUNT_EXCEEDS_RESERVATION')));
  });

  it('refuses every malformed candidate a non-type-checked caller can send (property, 1000 cases)', () => {
    const { authorization, state } = dispatched();
    const fields = [
      'attemptId',
      'fence',
      'maximumChargeableAmount',
      'priceBookVersion',
      'reservationId',
      'tenantId',
    ] as const;
    const hostileValues = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant(''),
      fc.constant(0),
      fc.constant(0n),
      fc.constant(-1n),
      fc.constant('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'),
      fc.constant('../../etc/passwd'),
      fc.constant({}),
      fc.constant([]),
      fc.string(),
    );
    fc.assert(
      fc.property(fc.constantFrom(...fields), hostileValues, (field, value) => {
        const candidate: Record<string, unknown> = { ...authorization, [field]: value };
        const outcome = attempt(() => admitProviderDispatch(candidate, state, SCOPE));
        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? '' : outcome.code).toMatch(/^DISPATCH_ADMISSION_/u);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('refuses a candidate that is not an object at all', () => {
    const { state } = dispatched();
    const candidates: readonly unknown[] = [null, undefined, 'authorized', 42, 0n, [], true];
    expect(
      candidates.map((candidate) => attempt(() => admitProviderDispatch(candidate, state, SCOPE))),
    ).toStrictEqual(candidates.map(() => refuses('DISPATCH_ADMISSION_MALFORMED')));
  });

  it('refuses a plausible forgery assembled entirely from valid-looking parts', () => {
    // Every field is individually well-formed; nothing about the object is
    // malformed. It is refused because it does not match a committed record.
    const forged = {
      attemptId: attemptId('99999999-9999-4999-8999-999999999999'),
      fence: fenceToken(1n),
      maximumChargeableAmount: positiveNanodollars(10_000_000_000n),
      priceBookVersion: PRICE_VERSION,
      reservationId: reservationId('99999999-9999-4999-8999-999999999998'),
      tenantId: TENANT,
    };
    const { state } = dispatched();
    expect(attempt(() => admitProviderDispatch(forged, state, SCOPE))).toStrictEqual(
      refuses('DISPATCH_ADMISSION_IDENTITY_MISMATCH'),
    );
  });

  it('admits a dispatch from exactly one of the six reservation states', () => {
    const { authorization, state } = dispatched();
    const byStatus: readonly ReservationState[] = [
      openReservation(),
      state,
      { ...state, observedAt: AT, status: 'uncertain', uncertainReason: 'provider_timeout' },
      {
        ...state,
        releasedAmount: positiveNanodollars(RESERVED - 1n),
        settledAmount: positiveNanodollars(1n),
        settledAt: AT,
        status: 'settled',
      },
      {
        ...state,
        releaseReason: 'expired_before_dispatch',
        releasedAmount: RESERVED,
        releasedAt: AT,
        status: 'released',
      },
      {
        ...state,
        adjustedAt: AT,
        adjustment: {
          actor: 'operator-a',
          reason: 'provider invoice reconciled',
          settledAmount: positiveNanodollars(1n),
          ticket: 'OPS-1',
        },
        releasedAmount: positiveNanodollars(RESERVED - 1n),
        settledAmount: positiveNanodollars(1n),
        status: 'adjusted',
      },
    ];

    const admittedStatuses = byStatus
      .filter(
        (persisted) => attempt(() => admitProviderDispatch(authorization, persisted, SCOPE)).ok,
      )
      .map((persisted) => persisted.status);

    expect(admittedStatuses).toStrictEqual(['dispatched']);
  });
});
