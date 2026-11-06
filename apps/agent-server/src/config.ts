import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export interface ModelConfig {
	baseUrl: string;
	id: string;
	apiKey: string;
	contextWindow: number;
	maxTokens: number;
}

export interface AssistantConfig {
	workspaceRoot: string;
	dataDir: string;
	host: string;
	port: number;
	model: ModelConfig | undefined;
	thinkingDisabled: boolean;
}

const DEFAULT_WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 4_096;

export function loadWorkspaceEnvironment(workspaceRoot = DEFAULT_WORKSPACE_ROOT): void {
	dotenv.config({ path: resolve(workspaceRoot, ".env"), quiet: true });
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

export function createConfig(
	env: NodeJS.ProcessEnv = process.env,
	workspaceRoot = DEFAULT_WORKSPACE_ROOT,
): AssistantConfig {
	const root = resolve(workspaceRoot);
	const port = parsePositiveInteger(env.PORT, 3001, "PORT");
	if (port > 65_535) throw new Error("PORT must be between 1 and 65535");

	const rawBaseUrl = env.OPENAI_BASE_URL?.trim();
	const id = env.OPENAI_MODEL?.trim();
	const apiKey = env.OPENAI_API_KEY?.trim();
	let model: ModelConfig | undefined;
	if (rawBaseUrl && id && apiKey) {
		let parsed: URL;
		try {
			parsed = new URL(rawBaseUrl);
		} catch {
			throw new Error("OPENAI_BASE_URL must be an absolute HTTP(S) URL");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("OPENAI_BASE_URL must be an absolute HTTP(S) URL");
		}
		if (parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new Error("OPENAI_BASE_URL cannot contain credentials, query parameters, or a fragment");
		}
		model = {
			baseUrl: rawBaseUrl.replace(/\/+$/, ""),
			id,
			apiKey,
			contextWindow: parsePositiveInteger(env.OPENAI_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, "OPENAI_CONTEXT_WINDOW"),
			maxTokens: parsePositiveInteger(env.OPENAI_MAX_TOKENS, DEFAULT_MAX_TOKENS, "OPENAI_MAX_TOKENS"),
		};
	}

	const configuredDataDir = env.DATA_DIR?.trim();
	const dataDir = configuredDataDir
		? resolve(root, configuredDataDir)
		: resolve(root, ".data", "assistant");

	return {
		workspaceRoot: root,
		dataDir,
		host: "127.0.0.1",
		port,
		model,
		thinkingDisabled: env.OPENAI_THINKING?.trim().toLowerCase() === "disabled"
			&& model?.id.toLowerCase().startsWith("mimo-") === true
			&& new URL(model.baseUrl).hostname.toLowerCase().endsWith("xiaomimimo.com"),
	};
}
