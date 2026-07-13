import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRecipientUnsubscribeUrl,
	computeBackoffDelay,
	deduplicateRecipients,
	isValidCampaignId,
	normalizeEmail,
} from "../src/utils.js";

test("normalizes and deduplicates recipient addresses", () => {
	const result = deduplicateRecipients([
		{ email: " Alice@Example.com ", name: "Alice" },
		{ email: "alice@example.com", name: "Duplicate" },
		{ email: "bob@example.com" },
	]);

	assert.equal(normalizeEmail(" Alice@Example.com "), "alice@example.com");
	assert.equal(result.duplicates, 1);
	assert.deepEqual(result.recipients, [{ email: "alice@example.com", name: "Alice" }, { email: "bob@example.com" }]);
});

test("validates campaign IDs", () => {
	assert.equal(isValidCampaignId("spring-2026.1"), true);
	assert.equal(isValidCampaignId("../unsafe"), false);
	assert.equal(isValidCampaignId(""), false);
});

test("builds a signed unsubscribe URL", () => {
	const url = buildRecipientUnsubscribeUrl({
		baseUrl: "https://emails.example.test/unsubscribe",
		secret: "test-secret",
		email: " Alice@Example.com ",
	});

	assert.ok(url);
	const parsed = new URL(url);
	assert.equal(parsed.pathname, "/unsubscribe");
	assert.match(parsed.searchParams.get("t") ?? "", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("computes bounded retry backoff with deterministic jitter", () => {
	assert.equal(computeBackoffDelay(500, 2, 0), 1000);
	assert.equal(computeBackoffDelay(500, 10, 0.99), 30_000);
});
