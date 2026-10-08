import { createHash } from "node:crypto";
import { type RecipientRecord } from "./recipients.js";
import { normalizeEmail } from "./utils.js";

export function excludeCampaignRecipients(recipients: RecipientRecord[], exclusions: RecipientRecord[]) {
	if (exclusions.length === 0) {
		return {
			recipients,
			excludedRows: 0,
			exclusionsSha256: createHash("sha256").update("").digest("hex"),
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
