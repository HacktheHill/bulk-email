import { parse } from "csv-parse";
import { parse as parseSync } from "csv-parse/sync";
import fs from "fs-extra";
import { z } from "zod";

export type RecipientRecord = Record<string, unknown> & { email: string };

export const recipientSchema = z
	.object({
		email: z.string().trim().toLowerCase().email(),
		name: z.string().optional().default(""),
		language: z.string().optional().default("en"),
		subject: z.string().optional(),
	})
	.passthrough();

export async function readRecipientCsv(file: string): Promise<RecipientRecord[]> {
	const recipients: RecipientRecord[] = [];
	const csvParser = fs.createReadStream(file).pipe(
		parse({
			bom: true,
			columns: true,
			skip_empty_lines: true,
			trim: true,
		}),
	);

	let rowNumber = 1;
	for await (const row of csvParser) {
		rowNumber++;
		const schema = recipientSchema.safeParse(row);

		if (!schema.success) {
			throw new Error(`Failed to validate CSV row ${rowNumber}: ${JSON.stringify(row)}`);
		}

		recipients.push(schema.data as RecipientRecord);
	}

	return recipients;
}

export function readRecipientCsvText(csv: string): RecipientRecord[] {
	const rows = parseSync(csv, {
		bom: true,
		columns: true,
		skip_empty_lines: true,
		trim: true,
	}) as unknown[];
	return validateRecipientRows(rows);
}

function validateRecipientRows(rows: unknown[]): RecipientRecord[] {
	return rows.map((row, index) => {
		const schema = recipientSchema.safeParse(row);
		if (!schema.success) {
			throw new Error(`Failed to validate CSV row ${index + 2}: ${JSON.stringify(row)}`);
		}
		return schema.data as RecipientRecord;
	});
}
