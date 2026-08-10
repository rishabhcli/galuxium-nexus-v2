/**
 * The reservation lifecycle, as a state machine that refuses invalid moves.
 *
 * This module is where four domain invariants stop being prose:
 *
 * - **I1 — no provider call starts without a committed reservation.** A caller
 *   cannot express a dispatch. It can only apply a `dispatch` event to an
 *   `open` reservation and receive a {@link DispatchAuthorization} back; that
 *   value is the only admission ticket the provider adapter accepts, and it is
 *   unforgeable outside this module.
 * - **I3 — every reservation reaches exactly one terminal accounting state.**
 *   The terminal statuses are `settled`, `released`, and `adjusted`. Every
 *   event applied to a terminal reservation is either refused or recognised as
 *   an exact repeat; none of them moves money a second time.
 * - **I4 — settlement and release are idempotent and balanced.** The released
 *   portion is computed here, never supplied by a caller, so
 *   `settled + released == reserved` holds by construction rather than by
 *   arithmetic performed correctly at each call site.
 * - **I6 — an unknown external outcome stays reserved.** `dispatched` and
 *   `uncertain` are distinct non-terminal states. Expiry may release an `open`
 *   reservation, because I1 guarantees no provider call began. Expiry may never
 *   release a `dispatched` one: it becomes `uncertain` and keeps holding the
 *   full amount until the reconciler resolves it with evidence or an audited
 *   manual adjustment.
 *
 * Fencing sits across all of them. Every event carries the fencing token its
 * holder believes is current. A holder that was superseded — a worker that
 * resurrected after the reaper moved on — is refused rather than allowed to
 * release money twice, which is the failure this product exists to prevent.
 */

import type {
  AttemptId,
  FenceToken,
  PriceBookVersion,
  ReservationId,
  TenantId,
} from './identity.js';
import {
  type NonNegativeNanodollars,
  type PositiveNanodollars,
  nonNegativeNanodollars,
  subtractNanodollars,
} from './money.js';
import type { InstantUtc } from './time.js';

export type ReservationStatus =
  'adjusted' | 'dispatched' | 'open' | 'released' | 'settled' | 'uncertain';

export const TERMINAL_RESERVATION_STATUSES = Object.freeze([
  'adjusted',
  'released',
  'settled',
] as const);

export type TerminalReservationStatus = (typeof TERMINAL_RESERVATION_STATUSES)[number];

export function isTerminalStatus(status: ReservationStatus): status is TerminalReservationStatus {
  return (TERMINAL_RESERVATION_STATUSES as readonly ReservationStatus[]).includes(status);
}

/** Why a reservation stopped holding money without a provider cost. */
export type ReleaseReason =
  | 'client_cancelled_before_dispatch'
  | 'expired_before_dispatch'
  | 'provider_refused_before_usage'
  | 'reconciled_zero_usage';

/** Why an outcome is not known, which is not the same as being zero. */
export type UncertainReason =
  | 'expiry_without_outcome'
  | 'provider_stream_interrupted'
  | 'provider_timeout'
  | 'provider_unparseable_response';

/** An audited human decision. The only escape from {@link UncertainReason}. */
export interface ManualAdjustment {
  readonly actor: string;
  readonly reason: string;
  readonly settledAmount: NonNegativeNanodollars;
  readonly ticket: string;
}

interface ReservationIdentity {
  readonly accountId: string;
  readonly attemptId: AttemptId;
  /** Retained forever with the attempt. Invariant I5. */
  readonly priceBookVersion: PriceBookVersion;
  readonly reservationId: ReservationId;
  readonly tenantId: TenantId;
}

interface ReservationHold extends ReservationIdentity {
  readonly expiresAt: InstantUtc;
  readonly fence: FenceToken;
  readonly reservedAmount: PositiveNanodollars;
}

export interface OpenReservation extends ReservationHold {
  readonly status: 'open';
}

export interface DispatchedReservation extends ReservationHold {
  readonly dispatchedAt: InstantUtc;
  readonly status: 'dispatched';
}

export interface UncertainReservation extends ReservationHold {
  readonly observedAt: InstantUtc;
  readonly status: 'uncertain';
  readonly uncertainReason: UncertainReason;
}

export interface SettledReservation extends ReservationHold {
  readonly releasedAmount: NonNegativeNanodollars;
  readonly settledAmount: NonNegativeNanodollars;
  readonly settledAt: InstantUtc;
  readonly status: 'settled';
}

export interface ReleasedReservation extends ReservationHold {
  readonly releaseReason: ReleaseReason;
  readonly releasedAmount: PositiveNanodollars;
  readonly releasedAt: InstantUtc;
  readonly status: 'released';
}

export interface AdjustedReservation extends ReservationHold {
  readonly adjustedAt: InstantUtc;
  readonly adjustment: ManualAdjustment;
  readonly releasedAmount: NonNegativeNanodollars;
  readonly settledAmount: NonNegativeNanodollars;
  readonly status: 'adjusted';
}

export type ReservationState =
  | AdjustedReservation
  | DispatchedReservation
  | OpenReservation
  | ReleasedReservation
  | SettledReservation
  | UncertainReservation;

export type TerminalReservation = AdjustedReservation | ReleasedReservation | SettledReservation;

/**
 * Narrow a reservation to its terminal form.
 *
 * Distinct from {@link isTerminalStatus}, which only narrows a status string. A
 * caller holding a whole reservation needs the state narrowed, otherwise it
 * reaches for the settled or released fields and finds them absent from the
 * union — which is the compiler correctly pointing out that the caller has not
 * established which terminal state it is looking at.
 */
export function isTerminalReservation(state: ReservationState): state is TerminalReservation {
  return isTerminalStatus(state.status);
}

export type ReservationEvent =
  | {
      readonly at: InstantUtc;
      readonly fence: FenceToken;
      readonly kind: 'apply_manual_adjustment';
      readonly adjustment: ManualAdjustment;
    }
  | {
      readonly at: InstantUtc;
      readonly fence: FenceToken;
      readonly kind: 'dispatch';
    }
  | {
      readonly at: InstantUtc;
      readonly fence: FenceToken;
      readonly kind: 'expire';
    }
  | {
      readonly at: InstantUtc;
      readonly fence: FenceToken;
      readonly kind: 'observe_unknown_outcome';
      readonly reason: UncertainReason;
    }
  | {
      readonly at: InstantUtc;
      readonly fence: FenceToken;
      readonly kind: 'observe_usage';
      readonly settledAmount: NonNegativeNanodollars;
    }
  | {
      readonly at: InstantUtc;
      readonly fence: FenceToken;
      readonly kind: 'release_unused';
      readonly reason: ReleaseReason;
    };

export type ReservationEventKind = ReservationEvent['kind'];

/**
 * The unforgeable admission ticket for a provider call. Returned only by a
 * committed `dispatch` transition, so invariant I1 is a compile-time property
 * of the adapter's signature rather than a runtime check the adapter might skip.
 */
export interface DispatchAuthorization {
  readonly attemptId: AttemptId;
  readonly fence: FenceToken;
  readonly maximumChargeableAmount: PositiveNanodollars;
  readonly priceBookVersion: PriceBookVersion;
  readonly reservationId: ReservationId;
  readonly tenantId: TenantId;
}

/**
 * How money moves as a result of a transition. Each movement is one debit and
 * one credit of the same amount, so an unbalanced movement cannot be
 * constructed. Invariant I4's "balanced" half is structural.
 */
export type MovementKind =
  'compensate_unreconciled_overspend' | 'release_reserved' | 'settle_reserved';

export interface LedgerMovement {
  readonly amount: PositiveNanodollars;
  readonly kind: MovementKind;
  readonly occurredAt: InstantUtc;
  readonly reservationId: ReservationId;
  readonly tenantId: TenantId;
}

export type TransitionRefusalCode =
  | 'RESERVATION_ADJUSTMENT_REQUIRES_UNCERTAIN'
  | 'RESERVATION_ALREADY_TERMINAL'
  | 'RESERVATION_DISPATCH_REQUIRES_OPEN'
  | 'RESERVATION_FENCE_STALE'
  | 'RESERVATION_RELEASE_REASON_MISMATCH'
  | 'RESERVATION_SETTLEMENT_EXCEEDS_RESERVATION'
  | 'RESERVATION_USAGE_REQUIRES_DISPATCH';

export type TransitionOutcome =
  | {
      readonly authorization?: DispatchAuthorization;
      readonly movements: readonly LedgerMovement[];
      readonly outcome: 'applied';
      readonly state: ReservationState;
    }
  | {
      readonly movements: readonly LedgerMovement[];
      readonly outcome: 'compensated';
      readonly reason: string;
      readonly state: TerminalReservation;
    }
  | {
      readonly outcome: 'already_applied';
      readonly state: TerminalReservation;
    }
  | {
      readonly code: TransitionRefusalCode;
      readonly outcome: 'refused';
      readonly reason: string;
    };

function refuse(code: TransitionRefusalCode, reason: string): TransitionOutcome {
  return { code, outcome: 'refused', reason };
}

function movement(
  state: ReservationHold,
  kind: MovementKind,
  amount: NonNegativeNanodollars,
  occurredAt: InstantUtc,
): readonly LedgerMovement[] {
  // A zero movement is not a movement. Writing one would put rows in the ledger
  // that no account balance depends on, and every reader would then have to
  // know to ignore them.
  if (amount === 0n) {
    return [];
  }
  return [
    {
      amount: amount as PositiveNanodollars,
      kind,
      occurredAt,
      reservationId: state.reservationId,
      tenantId: state.tenantId,
    },
  ];
}

function settle(
  state: DispatchedReservation | UncertainReservation,
  settledAmount: NonNegativeNanodollars,
  at: InstantUtc,
): TransitionOutcome {
  if (settledAmount > state.reservedAmount) {
    return refuse(
      'RESERVATION_SETTLEMENT_EXCEEDS_RESERVATION',
      'A settlement may never exceed the amount this attempt reserved',
    );
  }
  // Computed here, never accepted from a caller, so settled + released is
  // exactly reserved for every reservation that ever settles.
  const releasedAmount = nonNegativeNanodollars(
    subtractNanodollars(state.reservedAmount, settledAmount),
  );
  const settled: SettledReservation = {
    accountId: state.accountId,
    attemptId: state.attemptId,
    expiresAt: state.expiresAt,
    fence: state.fence,
    priceBookVersion: state.priceBookVersion,
    releasedAmount,
    reservationId: state.reservationId,
    reservedAmount: state.reservedAmount,
    settledAmount,
    settledAt: at,
    status: 'settled',
    tenantId: state.tenantId,
  };
  return {
    movements: [
      ...movement(state, 'settle_reserved', settledAmount, at),
      ...movement(state, 'release_reserved', releasedAmount, at),
    ],
    outcome: 'applied',
    state: settled,
  };
}

function repeatsTerminalState(state: TerminalReservation, event: ReservationEvent): boolean {
  switch (event.kind) {
    case 'observe_usage':
      return (
        (state.status === 'settled' || state.status === 'adjusted') &&
        state.settledAmount === event.settledAmount
      );
    case 'release_unused':
      return state.status === 'released' && state.releaseReason === event.reason;
    case 'expire':
      return state.status === 'released' && state.releaseReason === 'expired_before_dispatch';
    case 'apply_manual_adjustment':
      return (
        state.status === 'adjusted' &&
        state.adjustment.ticket === event.adjustment.ticket &&
        state.adjustment.settledAmount === event.adjustment.settledAmount
      );
    case 'dispatch':
    case 'observe_unknown_outcome':
      return false;
  }
}

function applyToTerminal(state: TerminalReservation, event: ReservationEvent): TransitionOutcome {
  if (repeatsTerminalState(state, event)) {
    // Invariant I4's idempotency half: an exact repeat is a no-op that returns
    // the prior result, so an at-least-once delivery cannot move money twice.
    return { outcome: 'already_applied', state };
  }

  if (
    event.kind === 'observe_usage' &&
    state.status === 'released' &&
    state.releaseReason === 'expired_before_dispatch' &&
    event.settledAmount > 0n
  ) {
    // Real spend arriving after the reaper released the hold. It cannot debit
    // available balance without violating I2, and it must not be discarded:
    // the money left the building. It is recorded against the tenant's
    // unreconciled-overspend account, where it is visible, auditable, and
    // alertable, rather than hidden or netted against a live budget.
    return {
      movements: movement(
        state,
        'compensate_unreconciled_overspend',
        event.settledAmount,
        event.at,
      ),
      outcome: 'compensated',
      reason:
        'Provider usage arrived after this reservation was released as expired; the cost is recorded as unreconciled overspend',
      state,
    };
  }

  return refuse(
    'RESERVATION_ALREADY_TERMINAL',
    `This reservation already reached the terminal ${state.status} state`,
  );
}

/**
 * Apply one event to one reservation.
 *
 * Total over the product of states and events: every combination either applies,
 * is recognised as an exact repeat, compensates, or is refused with a stable
 * code. There is no fall-through and no default case, so adding a state or an
 * event fails to compile until its behaviour is decided here.
 */
function applyToOpen(state: OpenReservation, event: ReservationEvent): TransitionOutcome {
  switch (event.kind) {
    case 'dispatch':
      return {
        authorization: {
          attemptId: state.attemptId,
          fence: state.fence,
          maximumChargeableAmount: state.reservedAmount,
          priceBookVersion: state.priceBookVersion,
          reservationId: state.reservationId,
          tenantId: state.tenantId,
        },
        movements: [],
        outcome: 'applied',
        state: { ...state, dispatchedAt: event.at, status: 'dispatched' },
      };
    case 'expire':
      return {
        movements: movement(state, 'release_reserved', state.reservedAmount, event.at),
        outcome: 'applied',
        state: {
          ...state,
          releaseReason: 'expired_before_dispatch',
          releasedAmount: state.reservedAmount,
          releasedAt: event.at,
          status: 'released',
        },
      };
    case 'release_unused':
      if (
        event.reason !== 'client_cancelled_before_dispatch' &&
        event.reason !== 'expired_before_dispatch'
      ) {
        return refuse(
          'RESERVATION_RELEASE_REASON_MISMATCH',
          'An undispatched reservation may only be released as cancelled or expired',
        );
      }
      return {
        movements: movement(state, 'release_reserved', state.reservedAmount, event.at),
        outcome: 'applied',
        state: {
          ...state,
          releaseReason: event.reason,
          releasedAmount: state.reservedAmount,
          releasedAt: event.at,
          status: 'released',
        },
      };
    case 'observe_usage':
      return refuse(
        'RESERVATION_USAGE_REQUIRES_DISPATCH',
        'Usage cannot exist for a reservation that never authorized a provider call',
      );
    case 'observe_unknown_outcome':
      return refuse(
        'RESERVATION_USAGE_REQUIRES_DISPATCH',
        'An outcome cannot be unknown for a reservation that never authorized a provider call',
      );
    case 'apply_manual_adjustment':
      return refuse(
        'RESERVATION_ADJUSTMENT_REQUIRES_UNCERTAIN',
        'A manual adjustment is only admissible for an uncertain outcome',
      );
  }
}

function applyToDispatched(
  state: DispatchedReservation,
  event: ReservationEvent,
): TransitionOutcome {
  switch (event.kind) {
    case 'observe_usage':
      return settle(state, event.settledAmount, event.at);
    case 'observe_unknown_outcome':
      return {
        movements: [],
        outcome: 'applied',
        state: {
          ...state,
          observedAt: event.at,
          status: 'uncertain',
          uncertainReason: event.reason,
        },
      };
    case 'expire':
      // Invariant I6. The provider call may already have happened, so the hold
      // stays and the reservation becomes uncertain. Releasing here is the
      // silent money leak this system exists to prevent, and no code path
      // reaches it.
      return {
        movements: [],
        outcome: 'applied',
        state: {
          ...state,
          observedAt: event.at,
          status: 'uncertain',
          uncertainReason: 'expiry_without_outcome',
        },
      };
    case 'release_unused':
      if (event.reason !== 'provider_refused_before_usage') {
        return refuse(
          'RESERVATION_RELEASE_REASON_MISMATCH',
          'A dispatched reservation may only be released on proof that the provider charged nothing',
        );
      }
      return {
        movements: movement(state, 'release_reserved', state.reservedAmount, event.at),
        outcome: 'applied',
        state: {
          ...state,
          releaseReason: event.reason,
          releasedAmount: state.reservedAmount,
          releasedAt: event.at,
          status: 'released',
        },
      };
    case 'dispatch':
      return refuse(
        'RESERVATION_DISPATCH_REQUIRES_OPEN',
        'This reservation has already authorized a provider call',
      );
    case 'apply_manual_adjustment':
      return refuse(
        'RESERVATION_ADJUSTMENT_REQUIRES_UNCERTAIN',
        'A manual adjustment is only admissible for an uncertain outcome',
      );
  }
}

function applyToUncertain(state: UncertainReservation, event: ReservationEvent): TransitionOutcome {
  switch (event.kind) {
    case 'observe_usage':
      return settle(state, event.settledAmount, event.at);
    case 'release_unused':
      if (event.reason !== 'reconciled_zero_usage') {
        return refuse(
          'RESERVATION_RELEASE_REASON_MISMATCH',
          'An uncertain reservation may only be released on reconciled proof of zero usage',
        );
      }
      return {
        movements: movement(state, 'release_reserved', state.reservedAmount, event.at),
        outcome: 'applied',
        state: {
          ...state,
          releaseReason: event.reason,
          releasedAmount: state.reservedAmount,
          releasedAt: event.at,
          status: 'released',
        },
      };
    case 'apply_manual_adjustment': {
      if (event.adjustment.settledAmount > state.reservedAmount) {
        return refuse(
          'RESERVATION_SETTLEMENT_EXCEEDS_RESERVATION',
          'A manual adjustment may never exceed the amount this attempt reserved',
        );
      }
      const releasedAmount = nonNegativeNanodollars(
        subtractNanodollars(state.reservedAmount, event.adjustment.settledAmount),
      );
      return {
        movements: [
          ...movement(state, 'settle_reserved', event.adjustment.settledAmount, event.at),
          ...movement(state, 'release_reserved', releasedAmount, event.at),
        ],
        outcome: 'applied',
        state: {
          ...state,
          adjustedAt: event.at,
          adjustment: event.adjustment,
          releasedAmount,
          settledAmount: event.adjustment.settledAmount,
          status: 'adjusted',
        },
      };
    }
    case 'expire':
    case 'observe_unknown_outcome':
      // Already holding for an unknown outcome. Re-observing the same condition
      // is not new information and must not move money.
      return { movements: [], outcome: 'applied', state };
    case 'dispatch':
      return refuse(
        'RESERVATION_DISPATCH_REQUIRES_OPEN',
        'This reservation has already authorized a provider call',
      );
  }
}

/**
 * Apply one event to one reservation.
 *
 * Total over the product of states and events: every combination either applies,
 * is recognised as an exact repeat, compensates, or is refused with a stable
 * code. Each per-status handler switches exhaustively over the event union with
 * no default case, so adding a state or an event fails to compile until its
 * behaviour has been decided here.
 */
export function applyReservationEvent(
  state: ReservationState,
  event: ReservationEvent,
): TransitionOutcome {
  if (event.fence !== state.fence) {
    // Checked before the status switch on purpose: a superseded holder must not
    // be able to reason about, or act on, the current state at all.
    return refuse(
      'RESERVATION_FENCE_STALE',
      'This holder has been superseded and may no longer move money for this reservation',
    );
  }

  switch (state.status) {
    case 'settled':
    case 'released':
    case 'adjusted':
      return applyToTerminal(state, event);
    case 'open':
      return applyToOpen(state, event);
    case 'dispatched':
      return applyToDispatched(state, event);
    case 'uncertain':
      return applyToUncertain(state, event);
  }
}

/**
 * The accounting identity every reservation must satisfy at rest.
 *
 * A non-terminal reservation holds its whole reserved amount and has settled
 * nothing. A terminal one has partitioned that amount into exactly one settled
 * part and one released part. Anything else is an imbalance, and an imbalance
 * must fail closed rather than be repaired silently.
 */
export function reservationAccounting(state: ReservationState): {
  readonly heldAmount: NonNegativeNanodollars;
  readonly releasedAmount: NonNegativeNanodollars;
  readonly settledAmount: NonNegativeNanodollars;
} {
  switch (state.status) {
    case 'open':
    case 'dispatched':
    case 'uncertain':
      return {
        heldAmount: state.reservedAmount,
        releasedAmount: nonNegativeNanodollars(0n),
        settledAmount: nonNegativeNanodollars(0n),
      };
    case 'settled':
    case 'adjusted':
      return {
        heldAmount: nonNegativeNanodollars(0n),
        releasedAmount: state.releasedAmount,
        settledAmount: state.settledAmount,
      };
    case 'released':
      return {
        heldAmount: nonNegativeNanodollars(0n),
        releasedAmount: state.releasedAmount,
        settledAmount: nonNegativeNanodollars(0n),
      };
  }
}
