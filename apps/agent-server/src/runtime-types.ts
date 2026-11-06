import type { JsonObject } from "@pi-vue3/protocol";

export interface AgentRuntimeCallbacks {
	onMessageStart(runtimeMessageId?: string): Promise<string>;
	onTextDelta(messageId: string, delta: string): Promise<void>;
	onMessageEnd(messageId: string, status?: "completed" | "failed"): Promise<void>;
	onToolStart(toolCallId: string, name: string, args: unknown): Promise<void>;
	onToolEnd(toolCallId: string, result: unknown, isError: boolean): Promise<void>;
	onSessionFile(sessionFile: string | undefined): Promise<void>;
}

export interface AgentRuntimeInput {
	sessionId: string;
	sessionFile: string | undefined;
	prompt: string;
	signal: AbortSignal;
	callbacks: AgentRuntimeCallbacks;
}

export interface AgentRunResult {
	sessionFile?: string;
}

export interface AgentRuntime {
	run(input: AgentRuntimeInput): Promise<AgentRunResult | void>;
}

export interface SubmitTaskRequest {
	text: string;
	clientRequestId?: string;
	context?: JsonObject;
}
