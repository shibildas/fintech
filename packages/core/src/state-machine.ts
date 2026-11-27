/**
 * Rule 6: Every transaction, payment, refund, mandate and subscription is a state machine.
 * Document the allowed transitions; reject any other transition with a clear error.
 */

export class InvalidStateTransitionError extends Error {
  public readonly entityType: string;
  public readonly fromState: string;
  public readonly toState: string;

  constructor(entityType: string, fromState: string, toState: string) {
    super(
      `Rule 6 Violation: Invalid ${entityType} state transition from "${fromState}" to "${toState}"`
    );
    this.name = "InvalidStateTransitionError";
    this.entityType = entityType;
    this.fromState = fromState;
    this.toState = toState;
  }
}

export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export function assertValidTransition<S extends string>(
  entityType: string,
  transitions: TransitionMap<S>,
  fromState: S,
  toState: S
): void {
  const allowedNext = transitions[fromState];
  if (!allowedNext || !allowedNext.includes(toState)) {
    throw new InvalidStateTransitionError(entityType, fromState, toState);
  }
}

/**
 * Project 1 Requirement 10 (Page 7):
 * RECEIVED -> DEBIT_REQUESTED -> DEBITED -> CREDIT_REQUESTED -> SUCCESS
 * DEBIT_REQUESTED -> FAILED
 * DEBIT_REQUESTED -> DEBIT_UNKNOWN -> (DEBITED | FAILED)
 * CREDIT_REQUESTED -> CREDIT_PENDING -> (SUCCESS | REVERSAL_REQUESTED -> REVERSED)
 */
export type SwitchTransactionState =
  | "RECEIVED"
  | "DEBIT_REQUESTED"
  | "DEBIT_UNKNOWN"
  | "DEBITED"
  | "FAILED"
  | "CREDIT_REQUESTED"
  | "CREDIT_PENDING"
  | "SUCCESS"
  | "REVERSAL_REQUESTED"
  | "REVERSED";

export const SWITCH_TRANSACTION_TRANSITIONS: TransitionMap<SwitchTransactionState> = {
  RECEIVED: ["DEBIT_REQUESTED"],
  DEBIT_REQUESTED: ["DEBITED", "FAILED", "DEBIT_UNKNOWN"],
  DEBIT_UNKNOWN: ["DEBITED", "FAILED"],
  DEBITED: ["CREDIT_REQUESTED"],
  FAILED: [],
  CREDIT_REQUESTED: ["SUCCESS", "CREDIT_PENDING"],
  CREDIT_PENDING: ["SUCCESS", "REVERSAL_REQUESTED"],
  SUCCESS: [],
  REVERSAL_REQUESTED: ["REVERSED"],
  REVERSED: [],
};

/**
 * Project 2 Requirement 6 (Page 13):
 * CREATED -> ATTEMPTED -> AUTHORIZED -> CAPTURED -> SETTLED
 * ATTEMPTED -> FAILED
 * CAPTURED -> PARTIALLY_REFUNDED | REFUNDED
 */
export type GatewayPaymentState =
  | "CREATED"
  | "ATTEMPTED"
  | "AUTHORIZED"
  | "VOIDED"
  | "CAPTURED"
  | "SETTLED"
  | "FAILED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export const GATEWAY_PAYMENT_TRANSITIONS: TransitionMap<GatewayPaymentState> = {
  CREATED: ["ATTEMPTED"],
  ATTEMPTED: ["AUTHORIZED", "FAILED"],
  AUTHORIZED: ["CAPTURED", "VOIDED"],
  VOIDED: [],
  CAPTURED: ["SETTLED", "PARTIALLY_REFUNDED", "REFUNDED"],
  SETTLED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  REFUNDED: [],
  FAILED: [],
};

/**
 * Project 3 Requirement 21 (Page 21):
 * OPEN -> UNDER_REVIEW -> RESOLVED_CREDITED | RESOLVED_REJECTED | ESCALATED
 */
export type DisputeState =
  "OPEN" | "UNDER_REVIEW" | "RESOLVED_CREDITED" | "RESOLVED_REJECTED" | "ESCALATED";

export const DISPUTE_TRANSITIONS: TransitionMap<DisputeState> = {
  OPEN: ["UNDER_REVIEW", "RESOLVED_CREDITED"],
  UNDER_REVIEW: ["RESOLVED_CREDITED", "RESOLVED_REJECTED", "ESCALATED"],
  ESCALATED: ["RESOLVED_CREDITED", "RESOLVED_REJECTED"],
  RESOLVED_CREDITED: [],
  RESOLVED_REJECTED: [],
};

/**
 * Project 4 Requirement 2 (Page 26):
 * CREATED -> AUTHENTICATED -> ACTIVE -> PAUSED | HALTED | CANCELLED | COMPLETED
 * with ACTIVE -> PAST_DUE while dunning runs.
 */
export type SubscriptionState =
  | "CREATED"
  | "AUTHENTICATED"
  | "ACTIVE"
  | "PAST_DUE"
  | "PAUSED"
  | "HALTED"
  | "CANCELLED"
  | "COMPLETED";

export const SUBSCRIPTION_TRANSITIONS: TransitionMap<SubscriptionState> = {
  CREATED: ["AUTHENTICATED", "CANCELLED"],
  AUTHENTICATED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAST_DUE", "PAUSED", "HALTED", "CANCELLED", "COMPLETED"],
  PAST_DUE: ["ACTIVE", "HALTED", "CANCELLED"],
  PAUSED: ["ACTIVE", "CANCELLED"],
  HALTED: ["ACTIVE", "CANCELLED"], // Recovery window reactivates to ACTIVE
  CANCELLED: [],
  COMPLETED: [],
};
