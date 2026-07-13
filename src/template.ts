import fs from "fs-extra";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type * as React from "react";
import { z } from "zod";
import type { TemplateProps } from "./mailer.js";

const execFileAsync = promisify(execFile);

export const emailTemplateMetadataSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
	version: z.number().int().positive(),
	audience: z.enum(["subscribers", "provided-csv"]),
	localization: z.enum(["bilingual", "localized"]),
	subject: z.string().trim().min(1).max(998),
	requiredFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(100),
});

export type EmailTemplateMetadata = z.infer<typeof emailTemplateMetadataSchema>;

export type TemplateModule = {
	default: (props: TemplateProps) => React.ReactElement;
	metadata: EmailTemplateMetadata;
};

export async function loadTemplateModule(templatePath: string): Promise<TemplateModule> {
	const imported = await import(pathToFileURL(path.resolve(templatePath)).toString()) as {
		default?: unknown;
		metadata?: unknown;
	};
	if (typeof imported.default !== "function") {
		throw new TypeError(`Template ${templatePath} must export a default React component`);
	}
	const metadata = emailTemplateMetadataSchema.safeParse(imported.metadata);
	if (!metadata.success) {
		throw new TypeError(`Template ${templatePath} has invalid metadata: ${metadata.error.issues.map(issue => issue.message).join("; ")}`);
	}
	return { default: imported.default as TemplateModule["default"], metadata: metadata.data };
}

export function validateRequiredFields(metadata: EmailTemplateMetadata, recipient: TemplateProps): void {
	const missing = metadata.requiredFields.filter(field => {
		const value = recipient[field];
		return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
	});
	if (missing.length > 0) {
		throw new Error(`Template ${metadata.id} is missing required field(s): ${missing.join(", ")}`);
	}
}

export async function inspectTemplateRepository(templatePath: string, options: { requireClean: boolean }): Promise<{
	commit: string;
	templateSha256: string;
	packageJsonPath: string;
}> {
	const absoluteTemplatePath = path.resolve(templatePath);
	const directory = path.dirname(absoluteTemplatePath);
	const [{ stdout: repositoryRoot }, { stdout: status }, { stdout: commit }] = await Promise.all([
		execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"]),
		execFileAsync("git", ["-C", directory, "status", "--porcelain"]),
		execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"]),
	]);
	if (options.requireClean && status.trim()) throw new Error("The template repository must be clean before a real send");
	const root = repositoryRoot.trim();
	const packageJsonPath = path.join(root, "package.json");
	if (!(await fs.pathExists(packageJsonPath))) throw new Error("The template repository has no package.json");
	return {
		commit: commit.trim(),
		templateSha256: createHash("sha256").update(await fs.readFile(absoluteTemplatePath)).digest("hex"),
		packageJsonPath,
	};
}

export async function verifyTemplateDependencies(templatePackageJsonPath: string, bulkPackageJsonPath: string): Promise<void> {
	const [templatePackage, bulkPackage] = await Promise.all([
		fs.readJson(templatePackageJsonPath) as Promise<PackageJson>,
		fs.readJson(bulkPackageJsonPath) as Promise<PackageJson>,
	]);
	for (const dependency of ["react", "react-dom", "@react-email/components", "@react-email/render"] as const) {
		const templateVersion = packageDependency(templatePackage, dependency);
		const bulkVersion = packageDependency(bulkPackage, dependency);
		if (!templateVersion || !bulkVersion || templateVersion !== bulkVersion) {
			throw new Error(`Template dependency mismatch for ${dependency}: template=${templateVersion ?? "missing"}, bulk-email=${bulkVersion ?? "missing"}`);
		}
	}
}

type PackageJson = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

function packageDependency(packageJson: PackageJson, dependency: string): string | undefined {
	return packageJson.dependencies?.[dependency] ?? packageJson.devDependencies?.[dependency];
}
