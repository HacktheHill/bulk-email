import { z } from "zod";
import { normalizeEmail } from "./utils.js";

const pageSchema = z.object({
	page: z.number().int().positive(),
	hasMore: z.boolean(),
	questions: z.array(z.object({ id: z.string(), title: z.string().nullable(), isDeleted: z.boolean().optional() })),
	submissions: z.array(z.object({
		id: z.string(), isCompleted: z.boolean(), submittedAt: z.string(),
		responses: z.array(z.object({
			questionId: z.string(), answer: z.unknown(), formattedAnswer: z.unknown().optional(),
			updatedAt: z.string().optional(),
		})),
	})),
});

export type Applicant = { email: string; language: "en" | "fr"; completed: boolean; updatedAt: number };

export function parseApplicantPage(data: unknown): { page: number; hasMore: boolean; ids: string[]; applicants: Applicant[]; missingEmail: number } {
	const parsed = pageSchema.parse(data);
	const questions = new Map(parsed.questions.map(q => [q.id, q.title?.trim()]));
	if (![...questions.values()].some(title => title === "Email address") ||
		![...questions.values()].some(title => title === "Adresse courriel")) {
		throw new Error("Tally applicant email fields could not be identified in both languages");
	}
	const applicants: Applicant[] = [];
	let missingEmail = 0;
	for (const submission of parsed.submissions) {
		const emails = new Set<string>();
		let language: "en" | "fr" = "en";
		let updatedAt = Date.parse(submission.submittedAt);
		if (!Number.isFinite(updatedAt)) throw new Error("Invalid Tally submission timestamp");
		for (const response of submission.responses) {
			const title = questions.get(response.questionId);
			if (response.updatedAt) {
				const timestamp = Date.parse(response.updatedAt);
				if (!Number.isFinite(timestamp)) throw new Error("Invalid Tally response timestamp");
				updatedAt = Math.max(updatedAt, timestamp);
			}
			const value = typeof response.answer === "string" ? response.answer :
				typeof response.formattedAnswer === "string" ? response.formattedAnswer : undefined;
			if (title === "Preferred Language / Langue préférée" && value === "Français") language = "fr";
			if ((title === "Email address" || title === "Adresse courriel") && value?.trim()) {
				const email = normalizeEmail(value);
				if (!z.string().email().safeParse(email).success) throw new Error("Invalid applicant email in Tally; review the source record");
				emails.add(email);
			}
		}
		if (emails.size === 0) {
			if (submission.isCompleted) throw new Error("Completed submission is missing an applicant email; cannot safely exclude it");
			missingEmail++;
		}
		for (const email of emails) applicants.push({ email, language, completed: submission.isCompleted, updatedAt });
	}
	return { page: parsed.page, hasMore: parsed.hasMore, ids: parsed.submissions.map(s => s.id), applicants, missingEmail };
}

export function buildReminderAudiences(applicants: Applicant[], now = Date.now()) {
	const completed = new Set(applicants.filter(a => a.completed).map(a => normalizeEmail(a.email)));
	const partial = new Map<string, Applicant>();
	for (const row of applicants.filter(a => !a.completed)) {
		const email = normalizeEmail(row.email);
		if (!partial.has(email) || partial.get(email)!.updatedAt < row.updatedAt) partial.set(email, { ...row, email });
	}
	const incomplete = [...partial.values()].filter(a => !completed.has(a.email) && now - a.updatedAt >= 24 * 60 * 60 * 1000);
	return {
		completed: [...completed].sort(),
		generalExclusions: [...new Set([...completed, ...partial.keys()])].sort(),
		incomplete: incomplete.sort((a, b) => a.email.localeCompare(b.email)),
		counts: { completed: completed.size, partialEmails: partial.size,
			partialAlreadyCompleted: [...partial.keys()].filter(e => completed.has(e)).length,
			partialTooRecent: [...partial.values()].filter(a => !completed.has(a.email) && now - a.updatedAt < 24 * 60 * 60 * 1000).length,
			incomplete: incomplete.length },
	};
}

export async function fetchTallyApplicants(token: string, formId: string): Promise<Applicant[]> {
	if (!token || !/^[A-Za-z0-9]+$/.test(formId)) throw new Error("TALLY_API_KEY and a valid form ID are required");
	const applicants: Applicant[] = [];
	const seen = new Set<string>();
	for (let page = 1; page <= 100; page++) {
		const response = await fetch(`https://api.tally.so/forms/${formId}/submissions?filter=all&limit=100&page=${page}`, {
			headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Tally audience fetch failed (HTTP ${response.status})`);
		const text = await response.text();
		if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error("Tally page exceeds size limit");
		let parsed: ReturnType<typeof parseApplicantPage>;
		try { parsed = parseApplicantPage(JSON.parse(text)); }
		catch (error) {
			if (error instanceof z.ZodError) {
				console.error("Tally schema mismatch:", JSON.stringify(error.issues.slice(0, 10).map(issue => ({ path: issue.path, code: issue.code }))));
			} else if (error instanceof Error && !(error instanceof SyntaxError)) {
				console.error(error.message);
			}
			// Do not attach the original error: schema errors can include applicant data.
			// eslint-disable-next-line preserve-caught-error
			throw new Error("Tally returned an unexpected audience schema; no send is permitted");
		}
		if (parsed.page !== page || parsed.ids.some(id => seen.has(id))) throw new Error("Tally pagination changed or repeated; retry a fresh preflight");
		for (const id of parsed.ids) seen.add(id);
		applicants.push(...parsed.applicants);
		if (!parsed.hasMore) {
			if (seen.size === 0) throw new Error("Tally returned no submissions; refusing an empty exclusion list");
			return applicants;
		}
		if (parsed.ids.length === 0) throw new Error("Tally returned an empty intermediate page");
	}
	throw new Error("Tally pagination exceeded its safety limit");
}
