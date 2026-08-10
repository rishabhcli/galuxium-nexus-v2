import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  accountId,
  attemptId,
  fenceToken,
  nextFenceToken,
  priceBookVersion,
  reservationId,
  tenantId,
} from '../src/identity.js';
import {
  type PositiveNanodollars,
  nonNegativeNanodollars,
  positiveNanodollars,
} from '../src/money.js';
import {
  type LedgerMovement,
  type ManualAdjustment,
  type OpenReservation,
  type ReleaseReason,
  type ReservationEvent,
  type ReservationState,
  type TerminalReservation,
  type TransitionOutcome,
  type UncertainReason,
  applyReservationEvent,
  isTerminalReservation,
  reservationAccounting,
} from '../src/reservation.js';
import { instantUtc } from '../src/time.js';

const FENCE = fenceToken(7n);
const RESERVED = positiveNanodollars(500_000_000n);
const AT = instantUtc(1_786_000_000_000_000n);

const RELEASE_REASONS: readonly ReleaseReason[] = [
  'client_cancelled_before_dispatch',
  'expired_before_dispatch',
  'provider_refused_before_usage',
  'reconciled_zero_usage',
];

const UNCERTAIN_REASONS: readonly UncertainReason[] = [
  'expiry_without_outcome',
  'provider_stream_interrupted',
  'provider_timeout',
  'provider_unparseable_response',
];

function openReservation(reservedAmount: PositiveNanodollars = RESERVED): OpenReservation {
  return {
    accountId: accountId('3f8b1c22-4d5e-4f60-8a71-9b2c3d4e5f60'),
    attemptId: attemptId('11111111-2222-4333-8444-555555555555'),
    expiresAt: instantUtc(AT + 30_000_000n),
    fence: FENCE,
    priceBookVersion: priceBookVersion('2026-08-10.1'),
    reservationId: reservationId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    reservedAmount,
    status: 'open',
    tenantId: tenantId('99999999-8888-4777-8666-555544443333'),
  };
}

/**
 * Narrow an outcome to `applied`, failing the test with a readable message
 * otherwise. Written as a throw rather than an assertion so that no `expect`
 * ends up inside a conditional, where it could silently stop running.
 */
function applied(outcome: TransitionOutcome): Extract<TransitionOutcome, { outcome: 'applied' }> {
  if (outcome.outcome !== 'applied') {
    throw new Error(`expected an applied transition, received ${outcome.outcome}`);
  }
  return outcome;
}

function compensated(
  outcome: TransitionOutcome,
): Extract<TransitionOutcome, { outcome: 'compensated' }> {
  if (outcome.outcome !== 'compensated') {
    throw new Error(`expected a compensated transition, received ${outcome.outcome}`);
  }
  return outcome;
}

const adjustmentArbitrary = (limit: bigint): fc.Arbitrary<ManualAdjustment> =>
  fc.record({
    actor: fc.constantFrom('operator-a', 'operator-b'),
    reason: fc.constantFrom('provider invoice reconciled', 'provider support confirmed usage'),
    settledAmount: fc.bigInt({ max: limit, min: 0n }).map((value) => nonNegativeNanodollars(value)),
    ticket: fc.constantFrom('OPS-1', 'OPS-2', 'OPS-3'),
  });

function eventArbitrary(reservedAmount: PositiveNanodollars): fc.Arbitrary<ReservationEvent> {
  const at = fc.bigInt({ max: 60_000_000n, min: 0n }).map((offset) => instantUtc(AT + offset));
  return fc.oneof(
    at.map((instant) => ({ at: instant, fence: FENCE, kind: 'dispatch' as const })),
    at.map((instant) => ({ at: instant, fence: FENCE, kind: 'expire' as const })),
    fc.tuple(at, fc.bigInt({ max: reservedAmount + 10n, min: 0n })).map(([instant, amount]) => ({
      at: instant,
      fence: FENCE,
      kind: 'observe_usage' as const,
      settledAmount: nonNegativeNanodollars(amount),
    })),
    fc.tuple(at, fc.constantFrom(...UNCERTAIN_REASONS)).map(([instant, reason]) => ({
      at: instant,
      fence: FENCE,
      kind: 'observe_unknown_outcome' as const,
      reason,
    })),
    fc.tuple(at, fc.constantFrom(...RELEASE_REASONS)).map(([instant, reason]) => ({
      at: instant,
      fence: FENCE,
      kind: 'release_unused' as const,
      reason,
    })),
    fc.tuple(at, adjustmentArbitrary(reservedAmount + 10n)).map(([instant, adjustment]) => ({
      adjustment,
      at: instant,
      fence: FENCE,
      kind: 'apply_manual_adjustment' as const,
    })),
  );
}

interface DriveResult {
  readonly movements: readonly LedgerMovement[];
  readonly state: ReservationState;
  readonly statuses: readonly ReservationState['status'][];
}

/** Apply a whole event sequence, keeping every state the reservation passed through. */
function drive(initial: ReservationState, events: readonly ReservationEvent[]): DriveResult {
  let state = initial;
  const movements: LedgerMovement[] = [];
  const statuses: ReservationState['status'][] = [initial.status];
  for (const event of events) {
    const outcome = applyReservationEvent(state, event);
    switch (outcome.outcome) {
      case 'applied':
      case 'compensated':
        state = outcome.state;
        movements.push(...outcome.movements);
        break;
      case 'already_applied':
        state = outcome.state;
        break;
      case 'refused':
        break;
    }
    statuses.push(state.status);
  }
  return { movements, state, statuses };
}

/** The exact event that produced this terminal state, replayed. */
function repeatOfTerminalEvent(state: TerminalReservation): ReservationEvent {
  switch (state.status) {
    case 'settled':
      return { at: AT, fence: FENCE, kind: 'observe_usage', settledAmount: state.settledAmount };
    case 'released':
      return { at: AT, fence: FENCE, kind: 'release_unused', reason: state.releaseReason };
    case 'adjusted':
      return {
        adjustment: state.adjustment,
        at: AT,
        fence: FENCE,
        kind: 'apply_manual_adjustment',
      };
  }
}

function totalOf(movements: readonly LedgerMovement[], kind: LedgerMovement['kind']): bigint {
  return movements
    .filter((entry) => entry.kind === kind)
    .reduce<bigint>((total, entry) => total + entry.amount, 0n);
}

const sequences = fc.array(eventArbitrary(RESERVED), { maxLength: 8, minLength: 1 });

describe('I3: every reservation reaches exactly one terminal accounting state', () => {
  it('never leaves a terminal status once entered (property, 2000 cases)', () => {
    const terminalStatuses: readonly string[] = ['adjusted', 'released', 'settled'];
    fc.assert(
      fc.property(sequences, (events) => {
        const { statuses } = drive(openReservation(), events);
        const firstTerminal = statuses.findIndex((status) => terminalStatuses.includes(status));
        const tail = firstTerminal === -1 ? [] : statuses.slice(firstTerminal);
        expect(tail).toStrictEqual(tail.map(() => statuses[firstTerminal]));
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('never moves a terminal reservation to a different status (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, eventArbitrary(RESERVED), (events, extra) => {
        const { state } = drive(openReservation(), events);
        fc.pre(isTerminalReservation(state));
        const outcome = applyReservationEvent(state, extra);
        expect(outcome.outcome).not.toBe('applied');
        const resultingStatus = outcome.outcome === 'refused' ? state.status : outcome.state.status;
        expect(resultingStatus).toBe(state.status);
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });
});

describe('I4: settlement and release are idempotent and balanced', () => {
  it('partitions the reserved amount exactly, in every reachable state (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, (events) => {
        const { state } = drive(openReservation(), events);
        const accounting = reservationAccounting(state);
        expect(accounting.heldAmount + accounting.releasedAmount + accounting.settledAmount).toBe(
          RESERVED,
        );
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('emits movements totalling the reserved amount once terminal, and none before (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, (events) => {
        const { movements, state } = drive(openReservation(), events);
        const moved =
          totalOf(movements, 'settle_reserved') + totalOf(movements, 'release_reserved');
        expect(moved).toBe(isTerminalReservation(state) ? RESERVED : 0n);
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('treats an exact repeat of the terminal event as a no-op returning the prior state (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, (events) => {
        const { state } = drive(openReservation(), events);
        fc.pre(isTerminalReservation(state));
        expect(applyReservationEvent(state, repeatOfTerminalEvent(state))).toStrictEqual({
          outcome: 'already_applied',
          state,
        });
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('refuses a settlement larger than the reservation rather than over-debiting', () => {
    const dispatched = applied(
      applyReservationEvent(openReservation(), { at: AT, fence: FENCE, kind: 'dispatch' }),
    );
    expect(
      applyReservationEvent(dispatched.state, {
        at: AT,
        fence: FENCE,
        kind: 'observe_usage',
        settledAmount: nonNegativeNanodollars(RESERVED + 1n),
      }),
    ).toMatchObject({
      code: 'RESERVATION_SETTLEMENT_EXCEEDS_RESERVATION',
      outcome: 'refused',
    });
  });
});

describe('I6: an unknown external outcome remains reserved', () => {
  it('holds the entire reservation while dispatched or uncertain (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, (events) => {
        const { state } = drive(openReservation(), events);
        fc.pre(state.status === 'dispatched' || state.status === 'uncertain');
        expect(reservationAccounting(state)).toStrictEqual({
          heldAmount: RESERVED,
          releasedAmount: 0n,
          settledAmount: 0n,
        });
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('turns expiry of a dispatched attempt into a held uncertainty, never a release', () => {
    const dispatched = applied(
      applyReservationEvent(openReservation(), { at: AT, fence: FENCE, kind: 'dispatch' }),
    );
    const expired = applied(
      applyReservationEvent(dispatched.state, {
        at: instantUtc(AT + 60_000_000n),
        fence: FENCE,
        kind: 'expire',
      }),
    );
    expect(expired.state.status).toBe('uncertain');
    expect(expired.movements).toStrictEqual([]);
    expect(reservationAccounting(expired.state).heldAmount).toBe(RESERVED);
  });

  it('releases an uncertain reservation only on reconciled proof of zero usage', () => {
    const uncertain = drive(openReservation(), [
      { at: AT, fence: FENCE, kind: 'dispatch' },
      { at: AT, fence: FENCE, kind: 'observe_unknown_outcome', reason: 'provider_timeout' },
    ]).state;
    expect(uncertain.status).toBe('uncertain');

    const wrongReasons = RELEASE_REASONS.filter((entry) => entry !== 'reconciled_zero_usage');
    expect(
      wrongReasons.map(
        (reason) =>
          applyReservationEvent(uncertain, {
            at: AT,
            fence: FENCE,
            kind: 'release_unused',
            reason,
          }).outcome,
      ),
    ).toStrictEqual(wrongReasons.map(() => 'refused'));

    expect(
      applied(
        applyReservationEvent(uncertain, {
          at: AT,
          fence: FENCE,
          kind: 'release_unused',
          reason: 'reconciled_zero_usage',
        }),
      ).state.status,
    ).toBe('released');
  });

  it('admits a manual adjustment only from an uncertain outcome, and only within the reservation', () => {
    const adjustment: ManualAdjustment = {
      actor: 'operator-a',
      reason: 'provider invoice reconciled',
      settledAmount: nonNegativeNanodollars(1n),
      ticket: 'OPS-1',
    };
    expect(
      applyReservationEvent(openReservation(), {
        adjustment,
        at: AT,
        fence: FENCE,
        kind: 'apply_manual_adjustment',
      }),
    ).toMatchObject({ code: 'RESERVATION_ADJUSTMENT_REQUIRES_UNCERTAIN', outcome: 'refused' });

    const uncertain = drive(openReservation(), [
      { at: AT, fence: FENCE, kind: 'dispatch' },
      { at: AT, fence: FENCE, kind: 'observe_unknown_outcome', reason: 'provider_timeout' },
    ]).state;
    expect(
      applyReservationEvent(uncertain, {
        adjustment: { ...adjustment, settledAmount: nonNegativeNanodollars(RESERVED + 1n) },
        at: AT,
        fence: FENCE,
        kind: 'apply_manual_adjustment',
      }),
    ).toMatchObject({ code: 'RESERVATION_SETTLEMENT_EXCEEDS_RESERVATION', outcome: 'refused' });
    expect(
      applied(
        applyReservationEvent(uncertain, {
          adjustment,
          at: AT,
          fence: FENCE,
          kind: 'apply_manual_adjustment',
        }),
      ).state.status,
    ).toBe('adjusted');
  });
});

describe('I1: no provider call starts without a committed reservation', () => {
  it('returns a dispatch authorization only from a committed open reservation (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, (events) => {
        let state: ReservationState = openReservation();
        const tickets: {
          readonly describesItsReservation: boolean;
          readonly kind: ReservationEvent['kind'];
          readonly previousStatus: ReservationState['status'];
        }[] = [];
        for (const event of events) {
          const previous = state;
          const outcome = applyReservationEvent(state, event);
          const authorization = outcome.outcome === 'applied' ? outcome.authorization : undefined;
          if (authorization !== undefined) {
            tickets.push({
              describesItsReservation:
                authorization.reservationId === previous.reservationId &&
                authorization.maximumChargeableAmount === previous.reservedAmount &&
                authorization.priceBookVersion === previous.priceBookVersion,
              kind: event.kind,
              previousStatus: previous.status,
            });
          }
          if (outcome.outcome !== 'refused') {
            state = outcome.state;
          }
        }
        // An admission ticket may only ever be produced by dispatching an open
        // reservation, and it may only ever describe that reservation.
        expect(tickets).toStrictEqual(
          tickets.map(() => ({
            describesItsReservation: true,
            kind: 'dispatch',
            previousStatus: 'open',
          })),
        );
        expect(tickets.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('refuses usage for a reservation that never authorized a call', () => {
    expect(
      applyReservationEvent(openReservation(), {
        at: AT,
        fence: FENCE,
        kind: 'observe_usage',
        settledAmount: nonNegativeNanodollars(1n),
      }),
    ).toMatchObject({ code: 'RESERVATION_USAGE_REQUIRES_DISPATCH', outcome: 'refused' });
    expect(
      applyReservationEvent(openReservation(), {
        at: AT,
        fence: FENCE,
        kind: 'observe_unknown_outcome',
        reason: 'provider_timeout',
      }),
    ).toMatchObject({ code: 'RESERVATION_USAGE_REQUIRES_DISPATCH', outcome: 'refused' });
  });
});

describe('fencing: a superseded holder may not move money', () => {
  it('refuses every event carrying a stale fence, from every state (property, 2000 cases)', () => {
    fc.assert(
      fc.property(
        sequences,
        eventArbitrary(RESERVED),
        fc.bigInt({ max: 64n, min: 1n }),
        (events, extra, drift) => {
          const { state } = drive(openReservation(), events);
          const staleFence = fenceToken(FENCE + drift);
          fc.pre(staleFence !== state.fence);
          expect(applyReservationEvent(state, { ...extra, fence: staleFence })).toStrictEqual({
            code: 'RESERVATION_FENCE_STALE',
            outcome: 'refused',
            reason:
              'This holder has been superseded and may no longer move money for this reservation',
          });
        },
      ),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('advances a fencing token strictly upward', () => {
    expect(nextFenceToken(FENCE)).toBe(FENCE + 1n);
    expect(nextFenceToken(nextFenceToken(FENCE))).toBe(FENCE + 2n);
  });
});

describe('usage arriving after the reaper released the hold', () => {
  it('records unreconciled overspend instead of hiding it or driving a balance negative', () => {
    const released = applied(
      applyReservationEvent(openReservation(), { at: AT, fence: FENCE, kind: 'expire' }),
    );
    expect(released.state.status).toBe('released');

    const late = compensated(
      applyReservationEvent(released.state, {
        at: instantUtc(AT + 3_600_000_000n),
        fence: FENCE,
        kind: 'observe_usage',
        settledAmount: nonNegativeNanodollars(120_000_000n),
      }),
    );
    // The reservation stays terminal; the cost is recorded elsewhere, visibly.
    expect(late.state.status).toBe('released');
    expect(late.movements).toHaveLength(1);
    expect(late.movements[0]).toMatchObject({
      amount: 120_000_000n,
      kind: 'compensate_unreconciled_overspend',
    });
    expect(reservationAccounting(late.state)).toStrictEqual({
      heldAmount: 0n,
      releasedAmount: RESERVED,
      settledAmount: 0n,
    });
  });

  it('does not invent a movement when the late usage is zero', () => {
    const released = applied(
      applyReservationEvent(openReservation(), { at: AT, fence: FENCE, kind: 'expire' }),
    );
    expect(
      applyReservationEvent(released.state, {
        at: AT,
        fence: FENCE,
        kind: 'observe_usage',
        settledAmount: nonNegativeNanodollars(0n),
      }),
    ).toMatchObject({ code: 'RESERVATION_ALREADY_TERMINAL', outcome: 'refused' });
  });
});

describe('movement construction', () => {
  it('never emits a zero-amount movement (property, 2000 cases)', () => {
    fc.assert(
      fc.property(sequences, (events) => {
        const { movements } = drive(openReservation(), events);
        expect(movements.filter((entry) => entry.amount <= 0n)).toStrictEqual([]);
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });

  it('carries the reservation and tenant on every movement (property, 2000 cases)', () => {
    const initial = openReservation();
    fc.assert(
      fc.property(sequences, (events) => {
        const { movements } = drive(initial, events);
        expect(
          movements.filter(
            (entry) =>
              entry.reservationId !== initial.reservationId || entry.tenantId !== initial.tenantId,
          ),
        ).toStrictEqual([]);
      }),
      { numRuns: 2_000, seed: 20260810 },
    );
  });
});

describe('settling the full reservation leaves nothing to release', () => {
  it('emits one settle movement and no release movement', () => {
    const result = drive(openReservation(), [
      { at: AT, fence: FENCE, kind: 'dispatch' },
      {
        at: AT,
        fence: FENCE,
        kind: 'observe_usage',
        settledAmount: nonNegativeNanodollars(RESERVED),
      },
    ]);
    expect(result.state.status).toBe('settled');
    expect(result.movements.map((entry) => entry.kind)).toStrictEqual(['settle_reserved']);
    expect(reservationAccounting(result.state)).toStrictEqual({
      heldAmount: 0n,
      releasedAmount: 0n,
      settledAmount: RESERVED,
    });
  });

  it('emits one release movement and no settle movement when nothing was used', () => {
    const result = drive(openReservation(), [
      { at: AT, fence: FENCE, kind: 'dispatch' },
      { at: AT, fence: FENCE, kind: 'observe_usage', settledAmount: nonNegativeNanodollars(0n) },
    ]);
    expect(result.state.status).toBe('settled');
    expect(result.movements.map((entry) => entry.kind)).toStrictEqual(['release_reserved']);
  });
});

describe('instants on movements', () => {
  it('stamps each movement with the event instant', () => {
    const at = instantUtc(AT + 5_000_000n);
    const result = drive(openReservation(), [
      { at: AT, fence: FENCE, kind: 'dispatch' },
      { at, fence: FENCE, kind: 'observe_usage', settledAmount: nonNegativeNanodollars(1n) },
    ]);
    expect(result.movements.map((entry) => entry.occurredAt)).toStrictEqual([at, at]);
  });
});
