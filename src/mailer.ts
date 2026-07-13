import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/render";
import { convert } from "html-to-text";
import * as React from "react";
import { computeBackoffDelay } from "./utils.js";

export type TemplateProps = Record<string, unknown>;

export type RateLimiter = {
	acquire: () => Promise<void>;
};

export type SendWithRetryInput = {
	ses: Pick<SESv2Client, "send">;
	from: string;
	fromName?: string;
	templateComponent: (props: TemplateProps) => React.ReactElement;
	recipient: TemplateProps;
	subject: string;
	maxAttempts: number;
	baseDelayMs: number;
	configurationSet?: string;
	rateLimiter: RateLimiter;
	unsubscribeUrl?: string;
	dev?: boolean;
	sleep?: (milliseconds: number) => Promise<void>;
};

export async function sendWithRetry(input: SendWithRetryInput): Promise<string | undefined> {
	const toAddress = String(input.recipient.email);
	const fromAddress = input.fromName ? `${input.fromName} <${input.from}>` : input.from;
	const renderedHtml = await render(React.createElement(input.templateComponent, input.recipient));
	const html = applyPlaceholders(renderedHtml, input.recipient);
	const text = convert(html, {
		wordwrap: 120,
		selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
	});
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
				Destination: { ToAddresses: [toAddress] },
				Content: {
					Simple: {
						Subject: { Data: input.subject, Charset: "UTF-8" },
						Body: {
							Html: { Data: html, Charset: "UTF-8" },
							Text: { Data: text, Charset: "UTF-8" },
						},
						Headers: headers,
					},
				},
				ConfigurationSetName: input.configurationSet,
			}));
			if (input.dev) console.info(`Sent to ${toAddress}: ${result.MessageId ?? "<no-id>"}`);
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

export function isRetryableSesError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const awsError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	if ((awsError.$metadata?.httpStatusCode ?? 0) >= 500) return true;
	return new Set([
		"Throttling",
		"ThrottlingException",
		"TooManyRequestsException",
		"ServiceUnavailableException",
		"InternalServiceError",
		"RequestTimeout",
	]).has(awsError.name ?? "");
}

export function applyPlaceholders(input: string, values: TemplateProps): string {
	return input.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
		const value = values[key];
		return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
			? String(value)
			: "";
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
