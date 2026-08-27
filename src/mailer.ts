import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { computeBackoffDelay } from "./utils.js";

export type TemplateProps = Record<string, unknown>;

export type RateLimiter = {
	acquire: () => Promise<void>;
};

export type SendWithRetryInput = {
	ses: Pick<SESv2Client, "send">;
	from: string;
	fromName?: string;
	replyTo?: string;
	to: string;
	subject: string;
	html: string;
	text: string;
	maxAttempts: number;
	baseDelayMs: number;
	configurationSet?: string;
	rateLimiter: RateLimiter;
	unsubscribeUrl?: string;
	dev?: boolean;
	abortSignal?: AbortSignal;
	sleep?: (milliseconds: number) => Promise<void>;
};

export async function sendWithRetry(input: SendWithRetryInput): Promise<string | undefined> {
	const fromAddress = input.fromName ? `${input.fromName} <${input.from}>` : input.from;
	if (!input.html.trim() || !input.text.trim()) {
		throw new Error("Template rendered an empty message body; refusing to send");
	}
	const sleep = input.sleep ?? delay;

	for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
		try {
			await input.rateLimiter.acquire();
			const headers = input.unsubscribeUrl
				? [
						{ Name: "List-Unsubscribe", Value: `<${input.unsubscribeUrl}>` },
						{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
					]
				: undefined;
			const result = await input.ses.send(new SendEmailCommand({
				FromEmailAddress: fromAddress,
				Destination: { ToAddresses: [input.to] },
				ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
				Content: {
					Simple: {
						Subject: { Data: input.subject, Charset: "UTF-8" },
						Body: {
							Html: { Data: input.html, Charset: "UTF-8" },
							Text: { Data: input.text, Charset: "UTF-8" },
						},
						Headers: headers,
					},
				},
				ConfigurationSetName: input.configurationSet,
			}), { abortSignal: input.abortSignal });
			if (input.dev) console.info(`SES accepted a message: ${result.MessageId ?? "<no-id>"}`);
			return result.MessageId;
		} catch (error) {
			if (!isRetryableSesError(error) || attempt === input.maxAttempts) throw error;
			const waitMs = computeBackoffDelay(input.baseDelayMs, attempt);
			console.warn(`Retrying a recipient after a transient SES error (attempt ${attempt}/${input.maxAttempts}).`);
			await sleep(waitMs);
		}
	}
}

export function createPerSecondRateLimiter(maxPerSecond: number): RateLimiter {
	let timestamps: number[] = [];
	return {
		acquire: async () => {
			while (true) {
				const now = Date.now();
				timestamps = timestamps.filter(timestamp => now - timestamp < 1000);
				if (timestamps.length < maxPerSecond) {
					timestamps.push(now);
					return;
				}
				await delay(Math.max(1, 1000 - (now - timestamps[0])));
			}
		},
	};
}

// ⚡ Bolt Optimization: Hoisted Set allocations to prevent O(N) reconstruction and memory allocation on every error check
const RETRYABLE_ERROR_NAMES = new Set([
	"Throttling",
	"ThrottlingException",
	"TooManyRequestsException",
	"ServiceUnavailableException",
	"InternalServiceError",
]);

export function isRetryableSesError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const awsError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	if ((awsError.$metadata?.httpStatusCode ?? 0) >= 500) return true;
	return RETRYABLE_ERROR_NAMES.has(awsError.name ?? "");
}

// ⚡ Bolt Optimization: Hoisted Set allocations to prevent O(N) reconstruction and memory allocation on every error check
const AMBIGUOUS_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "RequestTimeout"]);
const AMBIGUOUS_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);

export function isAmbiguousSesError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const networkError = error as { name?: unknown; code?: unknown };
	return AMBIGUOUS_ERROR_NAMES.has(String(networkError.name ?? ""))
		|| AMBIGUOUS_ERROR_CODES.has(String(networkError.code ?? ""));
}

export function applyPlaceholders(input: string, values: TemplateProps): string {
	return input.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
		const value = values[key];
		if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
			throw new Error(`Template contains an unresolved placeholder: ${key}`);
		}
		return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
			? String(value)
			: (() => { throw new Error(`Template placeholder ${key} is not a scalar value`); })();
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
