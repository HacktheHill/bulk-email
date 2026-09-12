import assert from "node:assert/strict";
import test from "node:test";
import { excludeCampaignRecipients } from "../src/campaign-exclusions.js";

test("completed and partial applicants are excluded without losing subscriber language", () => {
	const result = excludeCampaignRecipients([
		{ email: "Completed@Example.com" }, { email: "partial@example.com" },
		{ email: "keep@example.com", language: "fr" },
	], [{ email: " completed@example.com " }, { email: "PARTIAL@example.com" }]);
	assert.deepEqual(result.recipients, [{ email: "keep@example.com", language: "fr" }]);
	assert.equal(result.excludedRows, 2);
});

test("exclusion fingerprints are order independent and change when the audience changes", () => {
	const a = [{ email: "a@example.com" }, { email: "b@example.com" }];
	assert.equal(excludeCampaignRecipients([], a).exclusionsSha256,
		excludeCampaignRecipients([], [...a].reverse().concat(a)).exclusionsSha256);
	assert.notEqual(excludeCampaignRecipients([], a).exclusionsSha256,
		excludeCampaignRecipients([], a.slice(0, 1)).exclusionsSha256);
});
