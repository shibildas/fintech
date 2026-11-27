import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertPositivePaise, MoneyError } from "./money.ts";
import type { IsoResponseCode } from "./iso8583.ts";

/**
 * Rules 1, 2, 3, 4 & Project 1 Requirements 5, 6, 13, 14:
 * - Double-entry append-only postings table (1+ debit and 1+ credit summing to zero).
 * - Derived balances view (`ledger_balance_paise`, `active_holds_paise`, `available_balance_paise`).
 * - Reference chain (`transaction_id`, `rrn`, `message_id`, `settlement_cycle_id`, `reversal_of`).
 * - Atomic bank core debit keyed by RRN (PIN verify, 3-strike freeze, balance & daily limit check).
 */

export type PostingDirection = "DEBIT" | "CREDIT";

export interface AccountRecord {
  account_number: string;
  branch_code: string;
  holder_name: string;
  account_type: "CUSTOMER" | "MERCHANT" | "SETTLEMENT" | "REVENUE" | "TAX" | "RESERVE";
  pin_hash: string | null;
  wrong_pin_attempts: number;
  frozen_until: string | null;
  status: "ACTIVE" | "FROZEN";
  per_transaction_limit_paise: number;
  daily_limit_paise: number;
  created_at: string;
}

export interface AccountBalanceView {
  account_number: string;
  ledger_balance_paise: number;
  active_holds_paise: number;
  available_balance_paise: number;
}

export interface PostingRecord {
  id: string;
  journal_id: string;
  rrn: string;
  transaction_id: string;
  message_id: string | null;
  settlement_cycle_id: string | null;
  account_number: string;
  direction: PostingDirection;
  amount_paise: number;
  reversal_of: string | null;
  exception_id: string | null;
  created_at: string;
}

export interface JournalLineInput {
  accountNumber: string;
  direction: PostingDirection;
  amountPaise: number;
  reversalOf?: string | null;
}

export interface BankOperationResult {
  rrn: string;
  operation: "DEBIT" | "CREDIT" | "REVERSAL";
  response_code: IsoResponseCode;
  journal_id: string | null;
  available_balance_paise?: number;
  replayed: boolean;
}

export function hashPin(pin: string, salt = "NPCI_SIM_SALT"): string {
  return crypto.createHmac("sha256", salt).update(pin.trim(), "utf8").digest("hex");
}

export function initLedgerSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_number TEXT PRIMARY KEY,
      branch_code TEXT NOT NULL,
      holder_name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'CUSTOMER',
      pin_hash TEXT,
      wrong_pin_attempts INTEGER NOT NULL DEFAULT 0,
      frozen_until TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      per_transaction_limit_paise INTEGER NOT NULL DEFAULT 10000000,
      daily_limit_paise INTEGER NOT NULL DEFAULT 20000000,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_holds (
      id TEXT PRIMARY KEY,
      account_number TEXT NOT NULL,
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
      created_at TEXT NOT NULL,
      released_at TEXT,
      FOREIGN KEY (account_number) REFERENCES accounts(account_number)
    );

    CREATE TABLE IF NOT EXISTS postings (
      id TEXT PRIMARY KEY,
      journal_id TEXT NOT NULL,
      rrn TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      message_id TEXT,
      settlement_cycle_id TEXT,
      account_number TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
      reversal_of TEXT,
      exception_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_number) REFERENCES accounts(account_number),
      FOREIGN KEY (reversal_of) REFERENCES postings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_postings_account
      ON postings(account_number, created_at);

    CREATE INDEX IF NOT EXISTS idx_postings_rrn
      ON postings(rrn);

    CREATE INDEX IF NOT EXISTS idx_postings_journal
      ON postings(journal_id);

    -- Rule 3: Postings are strictly append-only. Never edit or delete a posting.
    CREATE TRIGGER IF NOT EXISTS trg_postings_no_update
    BEFORE UPDATE ON postings
    BEGIN
      SELECT RAISE(ABORT, 'Rule 3 Violation: postings are append-only and cannot be updated');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_postings_no_delete
    BEFORE DELETE ON postings
    BEGIN
      SELECT RAISE(ABORT, 'Rule 3 Violation: postings are append-only and cannot be deleted');
    END;

    -- Rule 2 & Project 1 Req 14: Balances are derived from postings; available excludes holds.
    CREATE VIEW IF NOT EXISTS account_balances_view AS
    SELECT
      a.account_number AS account_number,
      COALESCE(p.ledger_balance_paise, 0) AS ledger_balance_paise,
      COALESCE(h.active_holds_paise, 0) AS active_holds_paise,
      COALESCE(p.ledger_balance_paise, 0) - COALESCE(h.active_holds_paise, 0) AS available_balance_paise
    FROM accounts a
    LEFT JOIN (
      SELECT
        account_number,
        SUM(CASE WHEN direction = 'CREDIT' THEN amount_paise ELSE -amount_paise END) AS ledger_balance_paise
      FROM postings
      GROUP BY account_number
    ) p ON a.account_number = p.account_number
    LEFT JOIN (
      SELECT
        account_number,
        SUM(amount_paise) AS active_holds_paise
      FROM account_holds
      WHERE status = 'ACTIVE'
      GROUP BY account_number
    ) h ON a.account_number = h.account_number;

    -- Project 1 Req 5: Exactly-once operation store keyed by (rrn, operation)
    CREATE TABLE IF NOT EXISTS rrn_operations (
      rrn TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('DEBIT', 'CREDIT', 'REVERSAL')),
      response_code TEXT NOT NULL,
      journal_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rrn, operation)
    );
  `);
}

export class DoubleEntryLedger {
  private readonly db: DatabaseSync;
  public readonly settlementAccountNumber: string;

  constructor(db: DatabaseSync, settlementAccountNumber = "ACCT_NPCI_SETTLEMENT") {
    this.db = db;
    this.settlementAccountNumber = settlementAccountNumber;
    initLedgerSchema(this.db);
    this.ensureSettlementAccount();
  }

  private ensureSettlementAccount(): void {
    const existing = this.db
      .prepare(`SELECT account_number FROM accounts WHERE account_number = ?`)
      .get(this.settlementAccountNumber);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO accounts (
            account_number, branch_code, holder_name, account_type, status,
            per_transaction_limit_paise, daily_limit_paise, created_at
          ) VALUES (?, 'NPCI0000001', 'NPCI Switch Settlement Nostro', 'SETTLEMENT', 'ACTIVE', 999999999999, 999999999999, ?)`
        )
        .run(this.settlementAccountNumber, new Date().toISOString());
    }
  }

  public createAccount(params: {
    accountNumber: string;
    branchCode: string;
    holderName: string;
    accountType?: AccountRecord["account_type"];
    rawPin?: string;
    perTransactionLimitPaise?: number;
    dailyLimitPaise?: number;
    initialOpeningBalancePaise?: number;
  }): AccountRecord {
    const nowIso = new Date().toISOString();
    const accountType = params.accountType ?? "CUSTOMER";
    const pinHash = params.rawPin ? hashPin(params.rawPin) : null;
    const perTxnLimit = params.perTransactionLimitPaise ?? 10_000_000; // ₹1,00,000.00
    const dailyLimit = params.dailyLimitPaise ?? 20_000_000; // ₹2,00,000.00

    this.db
      .prepare(
        `INSERT INTO accounts (
          account_number, branch_code, holder_name, account_type, pin_hash,
          wrong_pin_attempts, frozen_until, status,
          per_transaction_limit_paise, daily_limit_paise, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, 'ACTIVE', ?, ?, ?)`
      )
      .run(
        params.accountNumber,
        params.branchCode,
        params.holderName,
        accountType,
        pinHash,
        perTxnLimit,
        dailyLimit,
        nowIso
      );

    if (params.initialOpeningBalancePaise && params.initialOpeningBalancePaise > 0) {
      assertPositivePaise(params.initialOpeningBalancePaise, "initialOpeningBalancePaise");
      this.postJournalEntry({
        rrn: `000000${String(Math.floor(Math.random() * 900000) + 100000)}`,
        transactionId: `OPENING-${params.accountNumber}`,
        lines: [
          {
            accountNumber: this.settlementAccountNumber,
            direction: "DEBIT",
            amountPaise: params.initialOpeningBalancePaise,
          },
          {
            accountNumber: params.accountNumber,
            direction: "CREDIT",
            amountPaise: params.initialOpeningBalancePaise,
          },
        ],
      });
    }

    return this.getAccount(params.accountNumber)!;
  }

  public getAccount(accountNumber: string): AccountRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM accounts WHERE account_number = ?`)
      .get(accountNumber) as unknown as AccountRecord | undefined;
  }

  public getBalance(accountNumber: string): AccountBalanceView {
    const row = this.db
      .prepare(`SELECT * FROM account_balances_view WHERE account_number = ?`)
      .get(accountNumber) as unknown as AccountBalanceView | undefined;
    if (!row) {
      throw new Error(`Account "${accountNumber}" not found`);
    }
    return row;
  }

  public placeHold(params: { accountNumber: string; amountPaise: number; reason: string }): string {
    assertPositivePaise(params.amountPaise, "holdAmountPaise");
    const balance = this.getBalance(params.accountNumber);
    if (balance.available_balance_paise < params.amountPaise) {
      throw new MoneyError(
        `Cannot place hold of ${params.amountPaise} paise: available balance is ${balance.available_balance_paise} paise`
      );
    }
    const holdId = `HLD-${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO account_holds (id, account_number, amount_paise, reason, status, created_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?)`
      )
      .run(
        holdId,
        params.accountNumber,
        params.amountPaise,
        params.reason,
        new Date().toISOString()
      );
    return holdId;
  }

  public releaseHold(holdId: string): void {
    this.db
      .prepare(
        `UPDATE account_holds SET status = 'RELEASED', released_at = ? WHERE id = ? AND status = 'ACTIVE'`
      )
      .run(new Date().toISOString(), holdId);
  }

  /**
   * Rule 2, 3, 4: Writes an atomic double-entry journal entry.
   * Requires at least 1 DEBIT and 1 CREDIT line, and `SUM(DEBIT) === SUM(CREDIT)`.
   */
  public postJournalEntry(params: {
    rrn: string;
    transactionId: string;
    messageId?: string | null;
    settlementCycleId?: string | null;
    exceptionId?: string | null;
    lines: JournalLineInput[];
    nowIso?: string;
  }): { journalId: string; postings: PostingRecord[] } {
    if (params.lines.length < 2) {
      throw new MoneyError(
        "Rule 2 Violation: A double-entry journal requires at least 2 posting lines"
      );
    }

    let totalDebit = 0;
    let totalCredit = 0;
    let hasDebit = false;
    let hasCredit = false;

    for (const line of params.lines) {
      assertPositivePaise(line.amountPaise, "line.amountPaise");
      if (line.direction === "DEBIT") {
        totalDebit += line.amountPaise;
        hasDebit = true;
      } else if (line.direction === "CREDIT") {
        totalCredit += line.amountPaise;
        hasCredit = true;
      } else {
        throw new MoneyError(`Invalid posting direction: ${String(line.direction)}`);
      }
    }

    if (!hasDebit || !hasCredit || totalDebit !== totalCredit) {
      throw new MoneyError(
        `Rule 2 Violation: Double-entry lines must have both DEBIT and CREDIT and sum to zero (debit=${totalDebit}, credit=${totalCredit})`
      );
    }

    const journalId = `JRN-${crypto.randomUUID()}`;
    const nowIso = params.nowIso ?? new Date().toISOString();
    const createdPostings: PostingRecord[] = [];

    const insertStmt = this.db.prepare(`
      INSERT INTO postings (
        id, journal_id, rrn, transaction_id, message_id, settlement_cycle_id,
        account_number, direction, amount_paise, reversal_of, exception_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of params.lines) {
      const posting: PostingRecord = {
        id: `PST-${crypto.randomUUID()}`,
        journal_id: journalId,
        rrn: params.rrn,
        transaction_id: params.transactionId,
        message_id: params.messageId ?? null,
        settlement_cycle_id: params.settlementCycleId ?? null,
        account_number: line.accountNumber,
        direction: line.direction,
        amount_paise: line.amountPaise,
        reversal_of: line.reversalOf ?? null,
        exception_id: params.exceptionId ?? null,
        created_at: nowIso,
      };
      insertStmt.run(
        posting.id,
        posting.journal_id,
        posting.rrn,
        posting.transaction_id,
        posting.message_id,
        posting.settlement_cycle_id,
        posting.account_number,
        posting.direction,
        posting.amount_paise,
        posting.reversal_of,
        posting.exception_id,
        posting.created_at
      );
      createdPostings.push(posting);
    }

    return { journalId, postings: createdPostings };
  }

  /**
   * Project 1 Requirements 5 & 6:
   * - Single database transaction that checks RRN idempotency, verifies PIN (with 3-strike freeze),
   *   checks available balance (excluding holds), checks per-txn & daily limits, posts double-entry lines,
   *   and records the RRN.
   */
  public debitCustomerAccountByRrn(params: {
    rrn: string;
    transactionId: string;
    accountNumber: string;
    amountPaise: number;
    rawPin: string;
    messageId?: string;
    now?: Date;
    freezeDurationMs?: number;
  }): BankOperationResult {
    assertPositivePaise(params.amountPaise, "amountPaise");
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const freezeDurationMs = params.freezeDurationMs ?? 30 * 60 * 1000; // 30 minutes default

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1. Requirement 5: Check if RRN was already processed
      const existingOp = this.db
        .prepare(
          `SELECT rrn, operation, response_code, journal_id
           FROM rrn_operations
           WHERE rrn = ? AND operation = 'DEBIT'`
        )
        .get(params.rrn) as
        | {
            rrn: string;
            operation: "DEBIT";
            response_code: IsoResponseCode;
            journal_id: string | null;
          }
        | undefined;

      if (existingOp) {
        this.db.exec("COMMIT");
        return {
          ...existingOp,
          replayed: true,
        };
      }

      const account = this.getAccount(params.accountNumber);
      if (!account) {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "DEBIT",
          response_code: "14",
          journal_id: null,
          replayed: false,
        };
      }

      // 2. Check if account is frozen (Acceptance Test 4)
      if (
        account.status === "FROZEN" ||
        (account.frozen_until && Date.parse(account.frozen_until) > now.getTime())
      ) {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "DEBIT",
          response_code: "55",
          journal_id: null,
          replayed: false,
        };
      }

      // 3. Verify UPI PIN (Acceptance Test 4: 3 wrong PINs freeze account)
      const providedPinHash = hashPin(params.rawPin);
      if (!account.pin_hash || account.pin_hash !== providedPinHash) {
        const newAttempts = account.wrong_pin_attempts + 1;
        const shouldFreeze = newAttempts >= 3;
        const frozenUntilIso = shouldFreeze
          ? new Date(now.getTime() + freezeDurationMs).toISOString()
          : null;
        this.db
          .prepare(
            `UPDATE accounts
             SET wrong_pin_attempts = ?,
                 status = ?,
                 frozen_until = ?
             WHERE account_number = ?`
          )
          .run(
            newAttempts,
            shouldFreeze ? "FROZEN" : account.status,
            frozenUntilIso,
            params.accountNumber
          );
        this.db.exec("COMMIT");
        return {
          rrn: params.rrn,
          operation: "DEBIT",
          response_code: "55",
          journal_id: null,
          replayed: false,
        };
      }

      // Reset wrong PIN counter on valid PIN
      if (account.wrong_pin_attempts > 0 || account.frozen_until !== null) {
        this.db
          .prepare(
            `UPDATE accounts SET wrong_pin_attempts = 0, frozen_until = NULL, status = 'ACTIVE' WHERE account_number = ?`
          )
          .run(params.accountNumber);
      }

      // 4. Check per-transaction limit and daily limit (Response Code 61)
      if (params.amountPaise > account.per_transaction_limit_paise) {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "DEBIT",
          response_code: "61",
          journal_id: null,
          replayed: false,
        };
      }

      const dayPrefix = nowIso.slice(0, 10); // YYYY-MM-DD
      const dailyRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(amount_paise), 0) AS today_debits
           FROM postings
           WHERE account_number = ?
             AND direction = 'DEBIT'
             AND created_at LIKE ?`
        )
        .get(params.accountNumber, `${dayPrefix}%`) as { today_debits: number };

      if (dailyRow.today_debits + params.amountPaise > account.daily_limit_paise) {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "DEBIT",
          response_code: "61",
          journal_id: null,
          replayed: false,
        };
      }

      // 5. Check available balance excluding holds (Acceptance Test 3: 51 Insufficient funds)
      const balance = this.getBalance(params.accountNumber);
      if (balance.available_balance_paise < params.amountPaise) {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "DEBIT",
          response_code: "51",
          journal_id: null,
          available_balance_paise: balance.available_balance_paise,
          replayed: false,
        };
      }

      // 6. Post Double-Entry lines (DEBIT customer, CREDIT settlement clearing) & record RRN
      const { journalId } = this.postJournalEntry({
        rrn: params.rrn,
        transactionId: params.transactionId,
        messageId: params.messageId ?? null,
        nowIso,
        lines: [
          {
            accountNumber: params.accountNumber,
            direction: "DEBIT",
            amountPaise: params.amountPaise,
          },
          {
            accountNumber: this.settlementAccountNumber,
            direction: "CREDIT",
            amountPaise: params.amountPaise,
          },
        ],
      });

      this.db
        .prepare(
          `INSERT INTO rrn_operations (rrn, operation, response_code, journal_id, created_at)
           VALUES (?, 'DEBIT', '00', ?, ?)`
        )
        .run(params.rrn, journalId, nowIso);

      const updatedBalance = this.getBalance(params.accountNumber);
      this.db.exec("COMMIT");

      return {
        rrn: params.rrn,
        operation: "DEBIT",
        response_code: "00",
        journal_id: journalId,
        available_balance_paise: updatedBalance.available_balance_paise,
        replayed: false,
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback error if already rolled back
      }
      throw err;
    }
  }

  /**
   * Credits the beneficiary account keyed by RRN (idempotent per RRN).
   */
  public creditCustomerAccountByRrn(params: {
    rrn: string;
    transactionId: string;
    accountNumber: string;
    amountPaise: number;
    messageId?: string;
    nowIso?: string;
  }): BankOperationResult {
    assertPositivePaise(params.amountPaise, "amountPaise");
    const nowIso = params.nowIso ?? new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingOp = this.db
        .prepare(
          `SELECT rrn, operation, response_code, journal_id
           FROM rrn_operations
           WHERE rrn = ? AND operation = 'CREDIT'`
        )
        .get(params.rrn) as
        | {
            rrn: string;
            operation: "CREDIT";
            response_code: IsoResponseCode;
            journal_id: string | null;
          }
        | undefined;

      if (existingOp) {
        this.db.exec("COMMIT");
        return { ...existingOp, replayed: true };
      }

      const account = this.getAccount(params.accountNumber);
      if (!account || account.status === "FROZEN") {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "CREDIT",
          response_code: "14",
          journal_id: null,
          replayed: false,
        };
      }

      const { journalId } = this.postJournalEntry({
        rrn: params.rrn,
        transactionId: params.transactionId,
        messageId: params.messageId ?? null,
        nowIso,
        lines: [
          {
            accountNumber: this.settlementAccountNumber,
            direction: "DEBIT",
            amountPaise: params.amountPaise,
          },
          {
            accountNumber: params.accountNumber,
            direction: "CREDIT",
            amountPaise: params.amountPaise,
          },
        ],
      });

      this.db
        .prepare(
          `INSERT INTO rrn_operations (rrn, operation, response_code, journal_id, created_at)
           VALUES (?, 'CREDIT', '00', ?, ?)`
        )
        .run(params.rrn, journalId, nowIso);

      const updatedBalance = this.getBalance(params.accountNumber);
      this.db.exec("COMMIT");

      return {
        rrn: params.rrn,
        operation: "CREDIT",
        response_code: "00",
        journal_id: journalId,
        available_balance_paise: updatedBalance.available_balance_paise,
        replayed: false,
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  /**
   * Rule 3 & Project 1 Requirement 8: Reverses an existing debit by appending
   * offsetting postings with `reversal_of` pointing to the original posting IDs.
   */
  public reverseDebitByRrn(params: {
    rrn: string;
    transactionId: string;
    messageId?: string;
    nowIso?: string;
  }): BankOperationResult {
    const nowIso = params.nowIso ?? new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRev = this.db
        .prepare(
          `SELECT rrn, operation, response_code, journal_id
           FROM rrn_operations
           WHERE rrn = ? AND operation = 'REVERSAL'`
        )
        .get(params.rrn) as
        | {
            rrn: string;
            operation: "REVERSAL";
            response_code: IsoResponseCode;
            journal_id: string | null;
          }
        | undefined;

      if (existingRev) {
        this.db.exec("COMMIT");
        return { ...existingRev, replayed: true };
      }

      const origDebitOp = this.db
        .prepare(
          `SELECT journal_id FROM rrn_operations WHERE rrn = ? AND operation = 'DEBIT' AND response_code = '00'`
        )
        .get(params.rrn) as { journal_id: string } | undefined;

      if (!origDebitOp) {
        this.db.exec("ROLLBACK");
        return {
          rrn: params.rrn,
          operation: "REVERSAL",
          response_code: "12",
          journal_id: null,
          replayed: false,
        };
      }

      const originalPostings = this.db
        .prepare(`SELECT * FROM postings WHERE journal_id = ?`)
        .all(origDebitOp.journal_id) as unknown as PostingRecord[];

      const reversingLines: JournalLineInput[] = originalPostings.map((orig) => ({
        accountNumber: orig.account_number,
        direction: orig.direction === "DEBIT" ? "CREDIT" : "DEBIT",
        amountPaise: orig.amount_paise,
        reversalOf: orig.id,
      }));

      const { journalId } = this.postJournalEntry({
        rrn: params.rrn,
        transactionId: params.transactionId,
        messageId: params.messageId ?? null,
        nowIso,
        lines: reversingLines,
      });

      this.db
        .prepare(
          `INSERT INTO rrn_operations (rrn, operation, response_code, journal_id, created_at)
           VALUES (?, 'REVERSAL', '00', ?, ?)`
        )
        .run(params.rrn, journalId, nowIso);

      this.db.exec("COMMIT");

      return {
        rrn: params.rrn,
        operation: "REVERSAL",
        response_code: "00",
        journal_id: journalId,
        replayed: false,
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  public listPostingsByRrn(rrn: string): PostingRecord[] {
    return this.db
      .prepare(`SELECT * FROM postings WHERE rrn = ? ORDER BY created_at ASC`)
      .all(rrn) as unknown as PostingRecord[];
  }
}
