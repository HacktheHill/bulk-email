export type ConfirmationPrompt = (message: string) => Promise<boolean>;

export async function confirmCampaignSend(input: {
	yes: boolean;
	prompt: ConfirmationPrompt;
	message?: string;
}): Promise<boolean> {
	if (input.yes) return true;
	return input.prompt(input.message ?? "Send this campaign now?");
}
