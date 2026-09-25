import { createHash } from "node:crypto";
import { type RecipientRecord } from "./recipients.js";
import { normalizeEmail } from "./utils.js";

export function excludeCampaignRecipients(recipients: RecipientRecord[], exclusions: RecipientRecord[]) {
	const excluded = new Set(exclusions.map(row => normalizeEmail(row.email)));
	const hasExcluded = excluded.size > 0;
	// ⚡ Bolt: Early return if there are no exclusions to prevent full-array traversal and string normalization
	if (!hasExcluded) {
		return {
			recipients,
			excludedRows: 0,
			exclusionsSha256: createHash("sha256").update("").digest("hex"),
		};
	}
	const pending = recipients.filter(row => !excluded.has(normalizeEmail(row.email)));
	return {
		recipients: pending,
		excludedRows: recipients.length - pending.length,
		exclusionsSha256: createHash("sha256").update([...excluded].sort().join("\n")).digest("hex"),
	};
}
