import {
	GetAccountCommand,
	GetConfigurationSetCommand,
	GetEmailIdentityCommand,
	ListSuppressedDestinationsCommand,
	type SESv2Client,
} from "@aws-sdk/client-sesv2";
import { normalizeEmail } from "./utils.js";

export async function verifySesPreflight(input: {
	client: SESv2Client;
	identity: string;
	configurationSet: string;
}): Promise<void> {
	const [account, identity, configurationSet] = await Promise.all([
		input.client.send(new GetAccountCommand({})),
		input.client.send(new GetEmailIdentityCommand({ EmailIdentity: input.identity })),
		input.client.send(new GetConfigurationSetCommand({ ConfigurationSetName: input.configurationSet })),
	]);

	if (!account.SendingEnabled || !account.ProductionAccessEnabled) {
		throw new Error("SES account is not enabled for production sending");
	}
	if (!identity.VerifiedForSendingStatus || identity.VerificationStatus !== "SUCCESS") {
		throw new Error(`SES identity ${input.identity} is not verified for sending`);
	}
	if (configurationSet.SendingOptions?.SendingEnabled === false) {
		throw new Error(`SES configuration set ${input.configurationSet} has sending disabled`);
	}
}

export async function fetchSesSuppressedEmailSet(client: SESv2Client): Promise<Set<string>> {
	const result = new Set<string>();
	let nextToken: string | undefined;
	do {
		const page = await client.send(new ListSuppressedDestinationsCommand({
			Reasons: ["BOUNCE", "COMPLAINT"],
			PageSize: 1000,
			NextToken: nextToken,
		}));
		for (const destination of page.SuppressedDestinationSummaries ?? []) {
			if (destination.EmailAddress) result.add(normalizeEmail(destination.EmailAddress));
		}
		nextToken = page.NextToken;
	} while (nextToken);
	return result;
}

export function mergeSuppressionSets(...sets: ReadonlySet<string>[]): Set<string> {
	const merged = new Set<string>();
	for (const set of sets) {
		for (const email of set) merged.add(normalizeEmail(email));
	}
	return merged;
}
