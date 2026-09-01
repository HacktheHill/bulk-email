import { render } from "@react-email/render";
import { compile } from "html-to-text";
import * as React from "react";
import type { TemplateProps } from "./mailer.js";
import { applyPlaceholders } from "./mailer.js";
import type { EmailTemplateMetadata, TemplateModule } from "./template.js";
import { validateRequiredFields } from "./template.js";

export type RenderLimits = {
	maxRecipients: number;
	maxHtmlBytes: number;
	maxTextBytes: number;
	maxTotalBytes: number;
};

export type RenderedMessage = {
	recipient: TemplateProps;
	email: string;
	subject: string;
	html: string;
	text: string;
	unsubscribeUrl?: string;
};

export async function renderCampaign(input: {
	template: TemplateModule;
	recipients: TemplateProps[];
	limits: RenderLimits;
	buildUnsubscribeUrl: (email: string) => string | undefined;
}): Promise<RenderedMessage[]> {
	if (input.recipients.length > input.limits.maxRecipients) {
		throw new Error(`Campaign exceeds the ${input.limits.maxRecipients}-recipient limit`);
	}
	const rendered: RenderedMessage[] = [];
	let totalBytes = 0;

	// Pre-compile html-to-text conversion options to avoid rebuilding the decision tree per recipient
	const htmlToText = compile({
		wordwrap: 120,
		selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
	});

	for (const recipient of input.recipients) {
		validateRequiredFields(input.template.metadata, recipient);
		const email = String(recipient.email);
		const unsubscribeUrl = input.template.metadata.audience === "subscribers"
			? input.buildUnsubscribeUrl(email)
			: undefined;
		if (input.template.metadata.audience === "subscribers" && !unsubscribeUrl) {
			throw new Error("Subscriber templates require a configured signed unsubscribe URL");
		}
		const props = unsubscribeUrl ? { ...recipient, unsubscribeUrl } : recipient;
		const subject = applyPlaceholders(input.template.metadata.subject, props).trim();
		if (!subject) throw new Error(`Template ${input.template.metadata.id} rendered an empty subject`);
		const html = await render(React.createElement(input.template.default, props));
		const text = htmlToText(html);
		validateRenderedMessage({ metadata: input.template.metadata, html, text, unsubscribeUrl });
		const htmlBytes = Buffer.byteLength(html, "utf8");
		const textBytes = Buffer.byteLength(text, "utf8");
		if (htmlBytes > input.limits.maxHtmlBytes) throw new Error(`Rendered HTML exceeds ${input.limits.maxHtmlBytes} bytes`);
		if (textBytes > input.limits.maxTextBytes) throw new Error(`Rendered text exceeds ${input.limits.maxTextBytes} bytes`);
		totalBytes += htmlBytes + textBytes;
		if (totalBytes > input.limits.maxTotalBytes) {
			throw new Error(`Pre-rendered campaign exceeds ${input.limits.maxTotalBytes} bytes`);
		}
		rendered.push({ recipient: props, email, subject, html, text, unsubscribeUrl });
	}
	return rendered;
}

export function validateRenderedMessage(input: {
	metadata: EmailTemplateMetadata;
	html: string;
	text: string;
	unsubscribeUrl?: string;
}): void {
	if (!input.html.trim() || !input.text.trim()) {
		throw new Error("Template rendered an empty message body; refusing to send");
	}
	// Fast string check before expensive Regex execution on large strings
	if ((input.html.includes("{{") && /\{\{\s*[A-Za-z][A-Za-z0-9_.]*\s*\}\}/.test(input.html)) || (input.text.includes("{{") && /\{\{\s*[A-Za-z][A-Za-z0-9_.]*\s*\}\}/.test(input.text))) {
		throw new Error("Template contains unresolved placeholders");
	}
	if (input.metadata.audience === "subscribers") {
		if (!input.unsubscribeUrl || !input.html.includes(input.unsubscribeUrl) || !input.text.includes(input.unsubscribeUrl)) {
			throw new Error("Subscriber template must visibly render its unsubscribe URL in HTML and text");
		}
	}
}
