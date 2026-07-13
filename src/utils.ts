import { createHmac } from "node:crypto";

export type EmailRecipient = {
	email: string;
	[key: string]: unknown;
};

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function deduplicateRecipients<T extends EmailRecipient>(
	recipients: T[],
): {
	recipients: T[];
	duplicates: number;
} {
	const seen = new Set<string>();
	const unique: T[] = [];

	for (const recipient of recipients) {
		const normalizedEmail = normalizeEmail(recipient.email);
		if (seen.has(normalizedEmail)) {
			continue;
		}

		seen.add(normalizedEmail);
		unique.push({ ...recipient, email: normalizedEmail });
	}

	return { recipients: unique, duplicates: recipients.length - unique.length };
}

export function isValidCampaignId(campaignId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(campaignId);
}

export function buildRecipientUnsubscribeUrl(input: {
	baseUrl?: string;
	secret?: string;
	email: string;
	staticUrl?: string;
}): string | undefined {
	const { baseUrl, secret, email, staticUrl } = input;

	if (baseUrl && secret) {
		const payload = JSON.stringify({ email: normalizeEmail(email), iat: Date.now() });
		const payloadB64 = base64UrlEncode(payload);
		const signatureB64 = base64UrlEncode(createHmac("sha256", secret).update(payloadB64).digest());
		const token = `${payloadB64}.${signatureB64}`;
		const url = new URL(baseUrl);
		url.searchParams.set("t", token);
		return url.toString();
	}

	return staticUrl;
}

export function base64UrlEncode(input: string | Buffer): string {
	const base64 = Buffer.isBuffer(input) ? input.toString("base64") : Buffer.from(input, "utf8").toString("base64");
	return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function computeBackoffDelay(baseDelayMs: number, attempt: number, random = Math.random()): number {
	const exponential = baseDelayMs * 2 ** (attempt - 1);
	const jitter = Math.floor(random * baseDelayMs);
	return Math.min(exponential + jitter, 30_000);
}
