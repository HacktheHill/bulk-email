export type ConfirmationPrompt = (message: string) => Promise<boolean>;

export async function confirmCampaignSend(input: {
	yes: boolean;
	prompt: ConfirmationPrompt;
}): Promise<boolean> {
	if (input.yes) return true;
	return input.prompt("Send this campaign now?");
}
