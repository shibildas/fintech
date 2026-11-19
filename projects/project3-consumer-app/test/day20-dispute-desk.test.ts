import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlaDeadlineMinHeap } from "@fintech/core";
import { ConsumerDisputeDesk } from "../src/dispute-desk.ts";

describe("Day 20 — Project 3: Dispute Desk Linked to Switch Reversals, Case Files & SLA Min-Heap", () => {
  it("1. Switch 0420 reversal event auto-resolves OPEN dispute to RESOLVED_CREDITED and notifies customer inbox", () => {
    const desk = new ConsumerDisputeDesk();
    const t0 = new Date("2026-11-24T10:00:00.000Z");

    const dispute = desk.openDispute({
      customerId: "cust_anita",
      switchRrn: "632810000123",
      reconExceptionId: "EXC-REC-001",
      category: "DEBITED_NOT_CREDITED",
      amountPaise: 150_000,
      customerNote: "Money debited from BANKA but shop did not receive it",
      now: t0,
    });
    assert.equal(dispute.state, "OPEN");

    // 2 hours later, Project 1 Switch 0420 reversal lands for RRN 632810000123
    const t1 = new Date("2026-11-24T12:00:00.000Z");
    const resolved = desk.handleSwitchReversalEvent({
      switchRrn: "632810000123",
      reversalReference: "REV-0420-991",
      now: t1,
    });

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].state, "RESOLVED_CREDITED");
    assert.ok(resolved[0].resolution_note?.includes("REV-0420-991"));

    const inbox = desk.listInboxNotifications("cust_anita");
    assert.equal(inbox.length, 2); // Opened + Auto-Resolved
    assert.ok(inbox[1].title.includes("Refund Credited"));
  });

  it("2. Escalated dispute produces downloadable Case File and SLA Min-Heap detects breached disputes", () => {
    const desk = new ConsumerDisputeDesk();
    const t0 = new Date("2026-11-24T08:00:00.000Z");

    const d1 = desk.openDispute({
      customerId: "cust_rahul",
      switchRrn: "632808000555",
      reconExceptionId: "EXC-MISSING-BEN",
      category: "DEBITED_NOT_CREDITED", // 24h SLA
      amountPaise: 500_000,
      customerNote: "Beneficiary bank never credited",
      now: t0,
    });

    const d2 = desk.openDispute({
      customerId: "cust_rahul",
      switchRrn: "632808000556",
      category: "UNAUTHORIZED_TRANSACTION", // 72h SLA
      amountPaise: 250_000,
      customerNote: "Unrecognized debit",
      now: t0,
    });

    // At +25 hours: d1 (24h SLA) is breached, d2 (72h SLA) is still within SLA
    const t25h = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
    const breached = desk.findSlaBreachedDisputes(t25h);
    assert.equal(breached.length, 1);
    assert.equal(breached[0].id, d1.id);

    // Escalate d1 and generate downloadable Case File
    desk.transitionDispute({ disputeId: d1.id, toState: "UNDER_REVIEW", now: t25h });
    desk.transitionDispute({
      disputeId: d1.id,
      toState: "ESCALATED",
      resolutionNote: "Escalated to NPCI arbitration after 24h TAT breach",
      now: t25h,
    });

    const caseFile = desk.generateEscalatedCaseFile(d1.id, t25h);
    assert.equal(caseFile.switch_rrn, "632808000555");
    assert.equal(caseFile.recon_exception_id, "EXC-MISSING-BEN");
    assert.ok(caseFile.summary_markdown.includes("632808000555"));
    assert.ok(d2.id.startsWith("dsp_"));
  });

  it("3. Day 20 Fintech DSA: SlaDeadlineMinHeap extracts breached deadlines in chronological order", () => {
    const heap = new SlaDeadlineMinHeap();
    heap.push({ entityId: "d3", deadlineMs: 3000, category: "C" });
    heap.push({ entityId: "d1", deadlineMs: 1000, category: "A" });
    heap.push({ entityId: "d2", deadlineMs: 2000, category: "B" });

    assert.equal(heap.peek()?.entityId, "d1");
    const due = heap.extractBreached(2500);
    assert.deepEqual(
      due.map((x) => x.entityId),
      ["d1", "d2"]
    );
    assert.equal(heap.peek()?.entityId, "d3");
  });
});
