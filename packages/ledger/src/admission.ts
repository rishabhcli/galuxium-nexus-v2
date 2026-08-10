/**
 * The runtime half of invariant I1.
 *
 * {@link DispatchAuthorization} makes "call the provider without a reservation"
 * fail to compile, which is the right primary defence and is worth nothing at a
 * boundary the compiler does not cover. An authorization arriving as JSON from a
 * queue, from a future service, from a test double, or through a hurried cast is
 * an ordinary untrusted object. Types are erased; this module is not.
 *
 * So every provider dispatch re-establishes the same fact against the
 * authoritative record, at the boundary, before any external call:
 *
 * - the candidate has the exact shape of an authorization;
 * - the persisted reservation is in `dispatched`, meaning a reservation was
 *   committed *and* the dispatch transition was durably recorded before the
 *   call;
 * - the candidate's fencing token is the record's current token, so a
 *   superseded holder is refused;
 * - identity matches on tenant, reservation, and attempt;
 * - the tenant scope asking for the dispatch owns the record (invariant I7).
 *
 * A refusal here is a designed, observable outcome with a stable code — not an
 * exception that happens to prevent the call.
 */

import { type TenantScope, attemptId, fenceToken, reservationId, tenantId } from './identity.js';
import { type PositiveNanodollars, positiveNanodollars } from './money.js';
import type { DispatchAuthorization, ReservationState } from './reservation.js';

export type DispatchAdmissionRefusalCode =
  | 'DISPATCH_ADMISSION_AMOUNT_EXCEEDS_RESERVATION'
  | 'DISPATCH_ADMISSION_FENCE_STALE'
  | 'DISPATCH_ADMISSION_IDENTITY_MISMATCH'
  | 'DISPATCH_ADMISSION_MALFORMED'
  | 'DISPATCH_ADMISSION_PRICE_VERSION_MISMATCH'
  | 'DISPATCH_ADMISSION_RESERVATION_NOT_DISPATCHED'
  | 'DISPATCH_ADMISSION_SCOPE_MISMATCH';

export class DispatchAdmissionError extends Error {
  readonly code: DispatchAdmissionRefusalCode;

  constructor(code: DispatchAdmissionRefusalCode, message: string) {
    super(message);
    this.name = 'DispatchAdmissionError';
    this.code = code;
  }
}

function refuse(code: DispatchAdmissionRefusalCode, message: string): never {
  throw new DispatchAdmissionError(code, message);
}

interface CandidateShape {
  readonly attemptId: string;
  readonly fence: bigint;
  readonly maximumChargeableAmount: PositiveNanodollars;
  readonly priceBookVersion: string;
  readonly reservationId: string;
  readonly tenantId: string;
}

/**
 * Validate the candidate's own shape before comparing it to anything.
 *
 * Deliberately re-runs the domain constructors rather than trusting the declared
 * types: an uppercase UUID, a fencing token of `0`, or a zero chargeable amount
 * all indicate the value did not come from this system, and each is refused
 * here rather than at whichever later comparison happens to notice.
 */
function admitShape(candidate: unknown): CandidateShape {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    refuse('DISPATCH_ADMISSION_MALFORMED', 'A dispatch authorization must be an object');
  }
  const record = candidate as Record<string, unknown>;
  try {
    return {
      attemptId: attemptId(record['attemptId']),
      fence: fenceToken(record['fence'] as bigint),
      maximumChargeableAmount: positiveNanodollars(record['maximumChargeableAmount'] as bigint),
      priceBookVersion: record['priceBookVersion'] as string,
      reservationId: reservationId(record['reservationId']),
      tenantId: tenantId(record['tenantId']),
    };
  } catch (error) {
    refuse(
      'DISPATCH_ADMISSION_MALFORMED',
      `A dispatch authorization field is not admissible: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}

/**
 * Admit one provider dispatch, or refuse it.
 *
 * `persisted` must be the reservation as read from the authoritative ledger
 * inside the same transaction or with the same read consistency as the dispatch
 * itself. Passing a cached copy would reintroduce exactly the cache-authorizes
 * hazard that invariant I8 exists to forbid, so callers hold a ledger read, not
 * a cache read.
 */
export function admitProviderDispatch(
  candidate: unknown,
  persisted: ReservationState,
  scope: TenantScope,
): DispatchAuthorization {
  const shape = admitShape(candidate);

  if (persisted.tenantId !== scope.tenantId) {
    refuse(
      'DISPATCH_ADMISSION_SCOPE_MISMATCH',
      'The reservation does not belong to the requesting tenant scope',
    );
  }
  if (shape.tenantId !== scope.tenantId) {
    refuse(
      'DISPATCH_ADMISSION_SCOPE_MISMATCH',
      'The authorization does not belong to the requesting tenant scope',
    );
  }
  if (persisted.status !== 'dispatched') {
    // The whole of I1 in one comparison: no provider call may begin unless the
    // committed record already says a dispatch was authorized for it.
    refuse(
      'DISPATCH_ADMISSION_RESERVATION_NOT_DISPATCHED',
      `A provider call requires a committed dispatched reservation, not one in ${persisted.status}`,
    );
  }
  if (
    shape.reservationId !== persisted.reservationId ||
    shape.attemptId !== persisted.attemptId ||
    shape.tenantId !== persisted.tenantId
  ) {
    refuse(
      'DISPATCH_ADMISSION_IDENTITY_MISMATCH',
      'The authorization does not identify the persisted reservation',
    );
  }
  if (shape.fence !== persisted.fence) {
    refuse(
      'DISPATCH_ADMISSION_FENCE_STALE',
      'This holder has been superseded and may not dispatch this attempt',
    );
  }
  if (shape.priceBookVersion !== persisted.priceBookVersion) {
    // Invariant I5: the version that authorized the spend is the version the
    // attempt is settled against. A mismatch means one of the two is a guess.
    refuse(
      'DISPATCH_ADMISSION_PRICE_VERSION_MISMATCH',
      'The authorization was priced against a different price book version',
    );
  }
  if (shape.maximumChargeableAmount !== persisted.reservedAmount) {
    refuse(
      'DISPATCH_ADMISSION_AMOUNT_EXCEEDS_RESERVATION',
      'The authorization does not match the amount this reservation holds',
    );
  }

  return {
    attemptId: persisted.attemptId,
    fence: persisted.fence,
    maximumChargeableAmount: persisted.reservedAmount,
    priceBookVersion: persisted.priceBookVersion,
    reservationId: persisted.reservationId,
    tenantId: persisted.tenantId,
  };
}
