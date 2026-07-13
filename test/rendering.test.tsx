import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderCampaign } from "../src/rendering.js";
import type { TemplateModule } from "../src/template.js";

const limits = {
	maxRecipients: 10,
	maxHtmlBytes: 10_000,
	maxTextBytes: 10_000,
	maxTotalBytes: 20_000,
};

test("pre-renders subscriber HTML and text with the visible unsubscribe URL", async () => {
	const template: TemplateModule = {
		metadata: {
			id: "subscriber-test",
			version: 1,
			audience: "subscribers",
			localization: "localized",
			subject: "Update for {{name}}",
			requiredFields: ["name"],
		},
		default: ({ name, unsubscribeUrl }) => React.createElement("div", null,
			React.createElement("p", null, `Hello ${String(name)}`),
			React.createElement("a", { href: String(unsubscribeUrl) }, "Unsubscribe"),
		),
	};
	const [message] = await renderCampaign({
		template,
		recipients: [{ email: "person@example.com", name: "Person", language: "en" }],
		limits,
		buildUnsubscribeUrl: () => "https://emails.hackthehill.com/unsubscribe?token=signed",
	});
	assert.equal(message?.subject, "Update for Person");
	assert.match(message?.html ?? "", /token=signed/);
	assert.match(message?.text ?? "", /token=signed/);
});

test("provided-CSV templates render without marketing unsubscribe data", async () => {
	let receivedUnsubscribe = false;
	const template: TemplateModule = {
		metadata: {
			id: "provided-test",
			version: 1,
			audience: "provided-csv",
			localization: "bilingual",
			subject: "RSVP reminder",
			requiredFields: [],
		},
		default: props => {
			receivedUnsubscribe = "unsubscribeUrl" in props;
			return React.createElement("p", null, "Your RSVP expires tomorrow.");
		},
	};
	const messages = await renderCampaign({
		template,
		recipients: [{ email: "person@example.com" }],
		limits,
		buildUnsubscribeUrl: () => { throw new Error("should not be called"); },
	});
	assert.equal(messages.length, 1);
	assert.equal(receivedUnsubscribe, false);
});

test("fails the entire preflight for missing fields, unresolved placeholders, or absent unsubscribe", async () => {
	const missingField: TemplateModule = {
		metadata: { id: "missing", version: 1, audience: "provided-csv", localization: "localized", subject: "Hi", requiredFields: ["name"] },
		default: () => React.createElement("p", null, "Hello"),
	};
	await assert.rejects(renderCampaign({ template: missingField, recipients: [{ email: "person@example.com" }], limits, buildUnsubscribeUrl: () => undefined }), /missing required field/);

	const unresolved: TemplateModule = {
		metadata: { id: "unresolved", version: 1, audience: "provided-csv", localization: "localized", subject: "Hi", requiredFields: [] },
		default: () => React.createElement("p", null, "Hello {{unknown}}"),
	};
	await assert.rejects(renderCampaign({ template: unresolved, recipients: [{ email: "person@example.com" }], limits, buildUnsubscribeUrl: () => undefined }), /unresolved placeholder/);

	const subscriber: TemplateModule = {
		metadata: { id: "subscriber", version: 1, audience: "subscribers", localization: "localized", subject: "Hi", requiredFields: [] },
		default: () => React.createElement("p", null, "Hello"),
	};
	await assert.rejects(renderCampaign({ template: subscriber, recipients: [{ email: "person@example.com" }], limits, buildUnsubscribeUrl: () => undefined }), /require a configured signed unsubscribe URL/);
});
