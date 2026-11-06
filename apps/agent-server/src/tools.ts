import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { readSkill } from "./skills.js";

export const DEMO_ITEMS = [
	{ id: "vue3", name: "Vue 3", category: "framework", summary: "Composition API and component UI" },
	{ id: "vite", name: "Vite", category: "build-tool", summary: "Development server and production bundling" },
	{ id: "sse", name: "Server-Sent Events", category: "transport", summary: "One-way streaming over HTTP" },
] as const;

export const MAX_DEMO_DELAY_MS = 3_000;

export function filterDemoItems(query?: string) {
	const normalized = query?.trim().toLocaleLowerCase();
	if (!normalized) return [...DEMO_ITEMS];
	return DEMO_ITEMS.filter((item) =>
		`${item.id} ${item.name} ${item.category} ${item.summary}`.toLocaleLowerCase().includes(normalized),
	);
}

function abortError(): Error {
	const error = new Error("Tool execution was cancelled.");
	error.name = "AbortError";
	return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	if (ms === 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createAssistantTools(skillRoot: string) {
	const getDemoItems = defineTool({
		name: "get_demo_items",
		label: "Get demo items",
		description: "Return a deterministic, read-only list of demo capabilities. Optionally filter it by query.",
		promptSnippet: "get_demo_items: inspect the deterministic demo capabilities",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_DEMO_DELAY_MS })),
		}),
		execute: async (_toolCallId, { query, delayMs }, signal) => {
			const boundedDelay = Math.max(0, Math.min(MAX_DEMO_DELAY_MS, delayMs ?? 0));
			await delay(boundedDelay, signal);
			const items = filterDemoItems(query);
			return {
				content: [{ type: "text", text: JSON.stringify(items) }],
				details: { items },
			};
		},
	});

	const readSkillTool = defineTool({
		name: "read_skill",
		label: "Read a Skill",
		description: "Read an allowlisted SKILL.md using its directory name, such as assistant-basics.",
		promptSnippet: "read_skill: read an allowlisted Skill by name",
		parameters: Type.Object({ name: Type.String() }),
		execute: async (_toolCallId, { name }, signal) => {
			if (signal?.aborted) throw abortError();
			const text = await readSkill(skillRoot, name);
			return { content: [{ type: "text", text }], details: { name } };
		},
	});

	return [getDemoItems, readSkillTool];
}
