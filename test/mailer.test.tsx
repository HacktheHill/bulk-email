import assert from "node:assert/strict";
import test from "node:test";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { isAmbiguousSesError, sendWithRetry, applyPlaceholders } from "../src/mailer.js";

test("retries transient SES errors and includes one-click unsubscribe headers", async () => {
	const commands: SendEmailCommand[] = [];
	let attempts = 0;
	const ses = {
		send: async (command: SendEmailCommand) => {
			commands.push(command);
			attempts++;
			if (attempts === 1) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
			return { MessageId: "message-id" };
		},
	} as unknown as Pick<SESv2Client, "send">;
	const sleeps: number[] = [];

	const messageId = await sendWithRetry({
		ses,
		from: "info@hackthehill.com",
		replyTo: "info@hackthehill.com",
		to: "member@example.com",
		subject: "Update",
		html: "<p>Update</p>",
		text: "Update",
		maxAttempts: 3,
		baseDelayMs: 1,
		configurationSet: "my-first-configuration-set",
		rateLimiter: { acquire: async () => undefined },
	unsubscribeUrl: "https://emails.hackthehill.com/unsubscribe?token=signed",
		sleep: async milliseconds => { sleeps.push(milliseconds); },
	});

	assert.equal(messageId, "message-id");
	assert.equal(attempts, 2);
	assert.equal(sleeps.length, 1);
	const headers = commands[1].input.Content?.Simple?.Headers;
	assert.deepEqual(headers, [
		{ Name: "List-Unsubscribe", Value: "<https://emails.hackthehill.com/unsubscribe?token=signed>" },
		{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
	]);
	assert.deepEqual(commands[1].input.ReplyToAddresses, ["info@hackthehill.com"]);
});

test("classifies transport timeouts and resets as ambiguous", () => {
	assert.equal(isAmbiguousSesError({ name: "TimeoutError" }), true);
	assert.equal(isAmbiguousSesError({ code: "ECONNRESET" }), true);
	assert.equal(isAmbiguousSesError({ name: "BadRequestException" }), false);
});

test("applyPlaceholders interpolates plain text values", () => {
	const subject = "Update for {{ name }}";
	const props = { name: "Alex" };

	const result = applyPlaceholders(subject, props);
	assert.equal(result, "Update for Alex");
});

test("refuses to send an empty rendered message body", async () => {
	let sendAttempts = 0;
	const ses = {
		send: async () => {
			sendAttempts++;
			return { MessageId: "should-not-send" };
		},
	} as unknown as Pick<SESv2Client, "send">;

	await assert.rejects(sendWithRetry({
		ses,
		from: "info@hackthehill.com",
		to: "member@example.com",
		subject: "Update",
		html: "",
		text: "",
		maxAttempts: 1,
		baseDelayMs: 1,
		rateLimiter: { acquire: async () => undefined },
	}), /empty message body/);
	assert.equal(sendAttempts, 0);
});
