import assert from "node:assert/strict";
import test from "node:test";
import { collectDecisionUpdates, parseTallySubmissionPage } from "../src/tally-sheet-sync.js";

test("parses the minimal Tally submission ledger", () => {
	assert.deepEqual(parseTallySubmissionPage({
		page: 1,
		hasMore: false,
		submissions: [
			{ id: "complete", isCompleted: true, ignored: "value" },
			{ id: "partial", isCompleted: false },
		],
	}), {
		page: 1,
		hasMore: false,
		submissions: [
			{ id: "complete", isCompleted: true },
			{ id: "partial", isCompleted: false },
		],
	});
});

test("accepts only blank decisions for completed Tally submissions", () => {
	const plan = collectDecisionUpdates(new Set(["blank", "accepted", "rejected", "waitlisted", "missing"]), [
		{ rowNumber: 2, submissionId: "blank", decision: "" },
		{ rowNumber: 3, submissionId: "accepted", decision: "Accepted" },
		{ rowNumber: 4, submissionId: "rejected", decision: "Rejected" },
		{ rowNumber: 5, submissionId: "waitlisted", decision: "Waitlisted" },
		{ rowNumber: 6, submissionId: "partial", decision: "" },
	]);
	assert.deepEqual(plan.updates, [{ rowNumber: 2, submissionId: "blank" }]);
	assert.deepEqual(plan.pendingSubmissionIds, ["missing"]);
});

test("refuses duplicate Sheet submission IDs", () => {
	assert.throws(() => collectDecisionUpdates(new Set(["duplicate"]), [
		{ rowNumber: 2, submissionId: "duplicate", decision: "" },
		{ rowNumber: 3, submissionId: "duplicate", decision: "" },
	]), /Duplicate submission ID/);
});
