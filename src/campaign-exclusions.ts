import { createHash } from "node:crypto";
import { type RecipientRecord } from "./recipients.js";
import { normalizeEmail } from "./utils.js";

const EMPTY_EXCLUSIONS_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function excludeCampaignRecipients(recipients: RecipientRecord[], exclusions: RecipientRecord[]) {
	if (exclusions.length === 0) {
		// ⚡ Bolt: Fast-path for empty exclusions to skip Set creation, iteration, and expensive SHA-256 hashing.
		return {
			recipients,
			excludedRows: 0,
			exclusionsSha256: EMPTY_EXCLUSIONS_SHA256,
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
