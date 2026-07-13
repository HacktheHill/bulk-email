import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emailTemplateMetadataSchema, verifyTemplateDependencies } from "../src/template.js";

test("validates the audience-driven template metadata contract", () => {
	assert.equal(emailTemplateMetadataSchema.parse({
		id: "save-the-date",
		version: 1,
		audience: "subscribers",
		localization: "bilingual",
		subject: "Save the date",
		requiredFields: [],
	}).audience, "subscribers");
	assert.throws(() => emailTemplateMetadataSchema.parse({
		id: "bad",
		version: 1,
		audience: "direct",
		localization: "bilingual",
		subject: "Bad",
		requiredFields: [],
	}));
});

test("fails closed when React Email runtime versions differ", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-template-"));
	try {
		const templatePackage = join(directory, "template.json");
		const bulkPackage = join(directory, "bulk.json");
		const common = {
			react: "18.3.1",
			"react-dom": "18.3.1",
			"@react-email/components": "1.0.12",
			"@react-email/render": "2.1.0",
		};
		await writeFile(templatePackage, JSON.stringify({ dependencies: common }));
		await writeFile(bulkPackage, JSON.stringify({ dependencies: { ...common, react: "19.0.0" } }));
		await assert.rejects(verifyTemplateDependencies(templatePackage, bulkPackage), /dependency mismatch for react/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
