import "dotenv/config";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const tallyPageSchema = z.object({
	page: z.number().int().positive(),
	hasMore: z.boolean(),
	submissions: z.array(z.object({
		id: z.string().min(1),
		isCompleted: z.boolean(),
	})),
});

const serviceAccountSchema = z.object({
	client_email: z.string().email(),
	private_key: z.string().min(1),
	token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
});

type ServiceAccount = z.infer<typeof serviceAccountSchema>;
type SheetRow = { rowNumber: number; submissionId: string; decision: string };

const DEFAULT_FORM_ID = "9qga9Q";
const DEFAULT_SPREADSHEET_ID = "1PlJ04NM3YvzRiiIGsJo56zzdYeh38kukzImQ6asXc9w";
const DEFAULT_SHEET_NAME = "Responses";
const ACCEPTED = "Accepted";

function base64Url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Interval must be a positive integer");
	return parsed;
}

export function parseTallySubmissionPage(data: unknown) {
	return tallyPageSchema.parse(data);
}

export function collectDecisionUpdates(completedIds: ReadonlySet<string>, rows: SheetRow[]) {
	const seen = new Set<string>();
	const updates: Array<{ rowNumber: number; submissionId: string }> = [];
	for (const row of rows) {
		if (!row.submissionId) continue;
		if (seen.has(row.submissionId)) throw new Error("Duplicate submission ID in Responses; refusing ambiguous updates");
		seen.add(row.submissionId);
		if (completedIds.has(row.submissionId) && row.decision.trim() === "") {
			updates.push({ rowNumber: row.rowNumber, submissionId: row.submissionId });
		}
	}
	return {
		updates,
		pendingSubmissionIds: [...completedIds].filter(id => !seen.has(id)).sort(),
	};
}

async function fetchTallyCompletedIds(token: string, formId: string): Promise<Set<string>> {
	if (!token || !/^[A-Za-z0-9]+$/.test(formId)) throw new Error("TALLY_API_KEY and a valid TALLY_FORM_ID are required");
	const completed = new Set<string>();
	const seen = new Set<string>();
	for (let page = 1; page <= 100; page++) {
		const response = await fetch(`https://api.tally.so/forms/${formId}/submissions?filter=all&limit=100&page=${page}`, {
			headers: { Authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Tally sync fetch failed (HTTP ${response.status})`);
		const text = await response.text();
		if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error("Tally page exceeds size limit");
		let parsed: z.infer<typeof tallyPageSchema>;
		try {
			parsed = parseTallySubmissionPage(JSON.parse(text));
		} catch (error) {
			if (error instanceof z.ZodError) {
				console.error("Tally schema mismatch:", JSON.stringify(error.issues.slice(0, 10).map(issue => ({ path: issue.path, code: issue.code }))));
			}
			// Do not attach the original error because it may contain submission data.
			// eslint-disable-next-line preserve-caught-error
			throw new Error("Tally returned an unexpected sync schema");
		}
		if (parsed.page !== page) throw new Error("Tally pagination changed; retrying on the next cycle");
		for (const submission of parsed.submissions) {
			if (seen.has(submission.id)) throw new Error("Tally repeated a submission ID; retrying on the next cycle");
			seen.add(submission.id);
			if (submission.isCompleted) completed.add(submission.id);
		}
		if (!parsed.hasMore) {
			if (seen.size === 0 || completed.size === 0) throw new Error("Tally returned an empty submission ledger");
			return completed;
		}
		if (parsed.submissions.length === 0) throw new Error("Tally returned an empty intermediate page");
	}
	throw new Error("Tally pagination exceeded its safety limit");
}

async function loadServiceAccount(): Promise<ServiceAccount> {
	if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
		return serviceAccountSchema.parse(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
	}
	const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (!path) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS is required");
	return serviceAccountSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

let cachedGoogleToken: { value: string; expiresAt: number } | undefined;

async function getGoogleAccessToken(account: ServiceAccount): Promise<string> {
	if (cachedGoogleToken && cachedGoogleToken.expiresAt - Date.now() > 5 * 60_000) return cachedGoogleToken.value;
	const now = Math.floor(Date.now() / 1000);
	const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claim = base64Url(JSON.stringify({
		iss: account.client_email,
		scope: "https://www.googleapis.com/auth/spreadsheets",
		aud: account.token_uri,
		iat: now,
		exp: now + 3600,
	}));
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${claim}`);
	signer.end();
	const assertion = `${header}.${claim}.${base64Url(signer.sign(account.private_key))}`;
	const response = await fetch(account.token_uri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Google OAuth failed (HTTP ${response.status})`);
	const body = z.object({ access_token: z.string(), expires_in: z.number().positive() }).parse(await response.json());
	cachedGoogleToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
	return body.access_token;
}

function quotedSheetName(name: string): string {
	return `'${name.replaceAll("'", "''")}'`;
}

async function googleRequest(token: string, url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, {
		...init,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Google Sheets request failed (HTTP ${response.status})`);
	return response.status === 204 ? undefined : response.json();
}

async function readSheetRows(token: string, spreadsheetId: string, sheetName: string): Promise<SheetRow[]> {
	const ranges = [
		`${quotedSheetName(sheetName)}!A:A`,
		`${quotedSheetName(sheetName)}!GQ:GQ`,
	];
	const query = new URLSearchParams({ majorDimension: "COLUMNS", valueRenderOption: "FORMATTED_VALUE" });
	for (const range of ranges) query.append("ranges", range);
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${query}`;
	const data = z.object({ valueRanges: z.array(z.object({ values: z.array(z.array(z.unknown())).optional() })) }).parse(await googleRequest(token, url));
	if (data.valueRanges.length !== 2) throw new Error("Google Sheets returned an unexpected range count");
	const ids = data.valueRanges[0].values?.[0] ?? [];
	const decisions = data.valueRanges[1].values?.[0] ?? [];
	if (ids[0] !== "Submission ID" || decisions[0] !== "Admission status") {
		throw new Error("Responses headers changed; refusing to update admission decisions");
	}
	return ids.slice(1).map((value, index) => {
		const decision = decisions[index + 1];
		return {
			rowNumber: index + 2,
			submissionId: typeof value === "string" ? value.trim() : "",
			decision: typeof decision === "string" ? decision.trim() : "",
		};
	});
}

async function readDecisionCells(token: string, spreadsheetId: string, sheetName: string, rowNumbers: number[]) {
	if (rowNumbers.length === 0) return new Map<number, string>();
	const query = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE" });
	for (const rowNumber of rowNumbers) query.append("ranges", `${quotedSheetName(sheetName)}!GQ${rowNumber}`);
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${query}`;
	const data = z.object({ valueRanges: z.array(z.object({ values: z.array(z.array(z.unknown())).optional() })) }).parse(await googleRequest(token, url));
	if (data.valueRanges.length !== rowNumbers.length) throw new Error("Google Sheets returned an unexpected decision range count");
	return new Map(rowNumbers.map((rowNumber, index) => {
		const value = data.valueRanges[index].values?.[0]?.[0];
		return [rowNumber, typeof value === "string" ? value.trim() : ""];
	}));
}

async function writeAccepted(token: string, spreadsheetId: string, sheetName: string, rowNumbers: number[]): Promise<void> {
	if (rowNumbers.length === 0) return;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;
	await googleRequest(token, url, {
		method: "POST",
		body: JSON.stringify({
			valueInputOption: "USER_ENTERED",
			data: rowNumbers.map(rowNumber => ({ range: `${quotedSheetName(sheetName)}!GQ${rowNumber}`, values: [[ACCEPTED]] })),
		}),
	});
}

export async function runSyncCycle(options: { dryRun: boolean }): Promise<void> {
	const formId = process.env.TALLY_FORM_ID ?? DEFAULT_FORM_ID;
	const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID ?? DEFAULT_SPREADSHEET_ID;
	const sheetName = process.env.GOOGLE_SHEET_NAME ?? DEFAULT_SHEET_NAME;
	const completedIds = await fetchTallyCompletedIds(process.env.TALLY_API_KEY ?? "", formId);
	const account = await loadServiceAccount();
	const googleToken = await getGoogleAccessToken(account);
	const rows = await readSheetRows(googleToken, spreadsheetId, sheetName);
	const plan = collectDecisionUpdates(completedIds, rows);

	const actionTimeValues = await readDecisionCells(googleToken, spreadsheetId, sheetName, plan.updates.map(row => row.rowNumber));
	const stillBlank = plan.updates.filter(row => actionTimeValues.get(row.rowNumber) === "");
	if (!options.dryRun) {
		await writeAccepted(googleToken, spreadsheetId, sheetName, stillBlank.map(row => row.rowNumber));
		const verified = await readDecisionCells(googleToken, spreadsheetId, sheetName, stillBlank.map(row => row.rowNumber));
		if (stillBlank.some(row => verified.get(row.rowNumber) !== ACCEPTED)) {
			throw new Error("Google Sheets verification failed after admission updates");
		}
	}
	console.log(JSON.stringify({
		at: new Date().toISOString(),
		dryRun: options.dryRun,
		completedTallySubmissions: completedIds.size,
		sheetSubmissionRows: rows.filter(row => row.submissionId).length,
		acceptedBlankDecisions: options.dryRun ? 0 : stillBlank.length,
		wouldAcceptBlankDecisions: options.dryRun ? stillBlank.length : 0,
		preservedConcurrentDecisions: plan.updates.length - stillBlank.length,
		pendingNativeTallyRows: plan.pendingSubmissionIds.length,
	}));
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const dryRun = args.has("--dry-run");
	const once = args.has("--once") || dryRun;
	const intervalSeconds = parsePositiveInteger(process.env.SYNC_INTERVAL_SECONDS, 300);
	let stopped = false;
	process.once("SIGINT", () => { stopped = true; });
	process.once("SIGTERM", () => { stopped = true; });
	do {
		const startedAt = Date.now();
		try {
			await runSyncCycle({ dryRun });
		} catch (error) {
			console.error(JSON.stringify({ at: new Date().toISOString(), error: error instanceof Error ? error.message : "Unknown sync error" }));
			if (once) process.exitCode = 1;
		}
		if (once || stopped) break;
		const remaining = Math.max(0, intervalSeconds * 1000 - (Date.now() - startedAt));
		await new Promise(resolve => setTimeout(resolve, remaining));
	} while (!stopped);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
