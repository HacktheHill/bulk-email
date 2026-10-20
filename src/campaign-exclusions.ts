import { createHash } from "node:crypto";
import { type RecipientRecord } from "./recipients.js";
import { normalizeEmail } from "./utils.js";

export function excludeCampaignRecipients(recipients: RecipientRecord[], exclusions: RecipientRecord[]) {
	if (exclusions.length === 0) {
		// Fast path: if there are no exclusions, skip the expensive set lookup and hashing
		return {
			recipients,
			excludedRows: 0,
			exclusionsSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		};
	}

	const excluded = new Set(exclusions.map(row => normalizeEmail(row.email)));
	const pending = recipients.filter(row => !excluded.has(normalizeEmail(row.email)));
	return {
		recipients: pending,
		excludedRows: recipients.length - pending.length,
		exclusionsSha256: createHash("sha256").update([...excluded].sort().join("\n")).digest("hex"),
	};
}
