import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { CampaignConfig } from "./campaign-config.js";
import { readRecipientCsvText, type RecipientRecord } from "./recipients.js";
import { readResponseTextWithLimit } from "./list-service.js";
import { buildReminderAudiences, parseApplicantPage, type Applicant } from "./tally-audience.js";

const pageSchema = z.object({
	page: z.number().int().positive(), hasMore: z.boolean(),
	questions: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
	submissions: z.array(z.object({
		id: z.string(), isCompleted: z.boolean(), submittedAt: z.string(),
		responses: z.array(z.object({ questionId: z.string(), answer: z.unknown(), formattedAnswer: z.unknown().optional(), updatedAt: z.string().optional() })),
	})),
});

export function firstName(values: string[]): string {
	const names = [...new Set(values.map(v => v.trim()).filter(Boolean))];
	const name = names.length === 1 ? names[0] : "";
	return name.length <= 60 && /^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]*$/u.test(name)
		&& !/^(test|unknown|none|null|n\/a)$/i.test(name) ? name : "";
}

export function emailSetDigest(recipients: RecipientRecord[]): string {
	return createHash("sha256").update([...new Set(recipients.map(r => r.email.trim().toLowerCase()))].sort().join("\n") + "\n").digest("hex");
}

export function verifyAudience(recipients: RecipientRecord[], expected?: { recipients: number; emailSetSha256: string }): void {
	if (expected && (new Set(recipients.map(r => r.email.trim().toLowerCase())).size !== expected.recipients
		|| emailSetDigest(recipients) !== expected.emailSetSha256)) throw new Error("Recipient count or email-set digest differs from the approved audience");
}

export function recipientCsv(rows: RecipientRecord[]): string {
	const keys = [...new Set(["email", ...rows.flatMap(row => Object.keys(row))])].sort();
	const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
	return [keys.map(quote).join(","), ...rows.map(row => keys.map(key => quote(row[key])).join(","))].join("\n") + "\n";
}

export async function resolveAudience(source: CampaignConfig["audience"], token: string, request = fetch, now = Date.now(),
	onExclusions?: (emails: string[]) => void): Promise<RecipientRecord[] | undefined> {
	if (source.type === "subscribers") return undefined; // The CLI owns the live export and marketing suppression policy.
	if (source.type === "csv") {
		const csv = source.encoding === "gzip-base64" ? gunzipSync(Buffer.from(source.data, "base64"), { maxOutputLength: 25 * 1024 * 1024 }).toString("utf8") : source.data;
		return readRecipientCsvText(csv);
	}
	if (!token) throw new Error("TALLY_API_KEY is required for a Tally audience");
	if (source.type === "tally-incomplete") {
		const applicants: Applicant[] = [];
		const seen = new Set<string>();
		try {
			for (let page = 1; page <= 100; page++) {
				const response = await request(`https://api.tally.so/forms/${source.formId}/submissions?filter=all&limit=100&page=${page}`, {
					headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
				});
				if (!response.ok) throw new Error();
				const data = pageSchema.parse(JSON.parse(await readResponseTextWithLimit(response, 10 * 1024 * 1024)));
				if (data.page !== page) throw new Error();
				const parsed = parseApplicantPage(data);
				if (parsed.ids.some(id => seen.has(id))) throw new Error();
				for (const id of parsed.ids) seen.add(id);
				applicants.push(...parsed.applicants);
				if (!data.hasMore) {
					if (seen.size === 0) throw new Error();
					const audiences = buildReminderAudiences(applicants, now, source.inactiveHours);
					onExclusions?.(audiences.completed);
					return audiences.incomplete
						.map(({ email, language }) => ({ email, language, name: "" }));
				}
				if (data.submissions.length === 0) throw new Error();
			}
			throw new Error();
		} catch {
			throw new Error("Incomplete Tally audience could not be verified; inspect the private source records before sending");
		}
	}
	const selected = new Set(source.submissionIds);
	const seen = new Set<string>();
	const found = new Set<string>();
	const recipients = new Map<string, RecipientRecord>();
	try {
		for (let page = 1; page <= 100; page++) {
			const response = await request(`https://api.tally.so/forms/${source.formId}/submissions?filter=all&limit=100&page=${page}`, {
				headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error();
			const data = pageSchema.parse(JSON.parse(await readResponseTextWithLimit(response, 10 * 1024 * 1024)));
			if (data.page !== page) throw new Error();
			const titles = new Map(data.questions.map(q => [q.id, q.title?.trim()]));
			for (const submission of data.submissions) {
				if (seen.has(submission.id)) throw new Error();
				seen.add(submission.id);
				if (!selected.has(submission.id)) continue;
				const parsed = parseApplicantPage({ ...data, submissions: [submission] });
				const applicant = parsed.applicants[0];
				if (parsed.applicants.length !== 1 || !applicant?.completed) throw new Error();
				found.add(submission.id);
				let name = firstName(submission.responses.filter(r => ["First name", "Prénom"].includes(titles.get(r.questionId) ?? ""))
					.map(r => typeof r.answer === "string" ? r.answer : ""));
				const previous = recipients.get(applicant.email);
				if (previous && previous.name !== name) name = "";
				recipients.set(applicant.email, { email: applicant.email, language: applicant.language, name });
			}
			if (!data.hasMore) {
				if (found.size !== selected.size) throw new Error();
				return [...recipients.values()].sort((a, b) => a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
			}
			if (data.submissions.length === 0) throw new Error();
		}
		throw new Error();
	} catch {
		throw new Error("Reviewed Tally audience could not be verified; inspect the private source records before sending");
	}
}
