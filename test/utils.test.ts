import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRecipientUnsubscribeUrl,
	computeBackoffDelay,
	deduplicateRecipients,
	isValidCampaignId,
	normalizeEmail,
	parseUnsubscribeKeyring,
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
		activeKeyId: "test-2026",
		keyring: { "test-2026": "test-versioned-unsubscribe-secret-2026" },
		email: " Alice@Example.com ",
	});

	assert.ok(url);
	const parsed = new URL(url);
	assert.equal(parsed.pathname, "/unsubscribe");
	assert.match(parsed.searchParams.get("token") ?? "", /^v1\.test-2026\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	assert.equal(parsed.searchParams.get("t"), null);
});

test("parses and validates the unsubscribe keyring", () => {
	assert.deepEqual(
		parseUnsubscribeKeyring('{"key-1":"01234567890123456789012345678901"}'),
		{ "key-1": "01234567890123456789012345678901" },
	);
	assert.throws(() => parseUnsubscribeKeyring('{"bad key":"short"}'), /invalid key/);
});

test("computes bounded retry backoff with deterministic jitter", () => {
	assert.equal(computeBackoffDelay(500, 2, 0), 1000);
	assert.equal(computeBackoffDelay(500, 10, 0.99), 30_000);
});
