import assert from "node:assert/strict";
import test from "node:test";
import { buildReminderAudiences, parseApplicantPage } from "../src/tally-audience.js";

test("completed applicants win over partials; latest activity controls the 24-hour wait", () => {
	const now = Date.now();
	const old = now - 48 * 3600_000;
	const base = { language: "en" as const, completed: false, updatedAt: old };
	const result = buildReminderAudiences([
		{ ...base, email: "done@example.com" }, { ...base, email: "DONE@example.com", completed: true },
		{ ...base, email: "recent@example.com" }, { ...base, email: "recent@example.com", updatedAt: now },
		{ ...base, email: "ready@example.com", language: "fr" },
	], now);
	assert.deepEqual(result.completed, ["done@example.com"]);
	assert.deepEqual(result.generalExclusions, ["done@example.com", "ready@example.com", "recent@example.com"]);
	assert.deepEqual(result.incomplete.map(a => [a.email, a.language]), [["ready@example.com", "fr"]]);
});

test("extracts both applicant email fields but never the guardian email", () => {
	const data = { page: 1, hasMore: false, questions: [
		{ id: "en", title: "Email address" }, { id: "fr", title: "Adresse courriel" },
		{ id: "parent", title: "Parent or legal guardian’s email address" },
	], submissions: [{ id: "one", isCompleted: true, submittedAt: "2026-09-01T00:00:00Z", responses: [
		{ questionId: "fr", answer: " FR@example.com " }, { questionId: "parent", answer: "parent@example.com" },
	] }] };
	assert.deepEqual(parseApplicantPage(data).applicants.map(a => a.email), ["fr@example.com"]);
	const withChoiceAnswer = structuredClone(data) as typeof data & { submissions: Array<{ responses: unknown[] }> };
	(withChoiceAnswer.submissions[0].responses as unknown[]).push({ questionId: "unrelated", answer: ["option-id"], formattedAnswer: ["A choice"] });
	assert.deepEqual(parseApplicantPage(withChoiceAnswer).applicants.map(a => a.email), ["fr@example.com"]);
	data.submissions[0].responses = [{ questionId: "parent", answer: "parent@example.com" }];
	assert.throws(() => parseApplicantPage(data), /missing an applicant email/);
	data.submissions[0].isCompleted = false;
	assert.equal(parseApplicantPage(data).missingEmail, 1);
	data.submissions[0].responses = [{ questionId: "en", answer: "unfinished@" }];
	assert.equal(parseApplicantPage(data).missingEmail, 1);
	data.submissions[0].isCompleted = true;
	assert.throws(() => parseApplicantPage(data), /Invalid completed applicant email/);
});
