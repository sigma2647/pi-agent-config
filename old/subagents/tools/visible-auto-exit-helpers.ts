export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
	return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
	autoExit: boolean,
	_userTookOver: boolean,
	gracefulReturnRequested: boolean,
	messages: Array<{ role?: string; stopReason?: string }> | undefined,
): boolean {
	if (!autoExit && !gracefulReturnRequested) return false;
	const lastAssistant = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
	return lastAssistant?.stopReason !== "aborted";
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
	return (rawValue ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}
