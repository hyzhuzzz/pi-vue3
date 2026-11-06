import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSkill } from "./skills.js";

let root = "";

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = "";
});

describe("readSkill", () => {
	it("reads only a named Skill's SKILL.md beneath the configured root", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-agent-skill-"));
		await mkdir(join(root, "assistant-basics"));
		await writeFile(join(root, "assistant-basics", "SKILL.md"), "Use get_demo_items for checks.");

		expect(await readSkill(root, "assistant-basics")).toBe("Use get_demo_items for checks.");
		await expect(readSkill(root, "../outside")).rejects.toMatchObject({ code: "skill_not_found" });
	});

	it("rejects a Skill directory symlink that escapes the allowlisted root", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-agent-skill-link-"));
		const skillRoot = join(root, "skills");
		const outside = join(root, "outside");
		await mkdir(skillRoot);
		await mkdir(outside);
		await writeFile(join(outside, "SKILL.md"), "private");
		try {
			await symlink(outside, join(skillRoot, "escape"), "junction");
		} catch {
			return;
		}

		await expect(readSkill(skillRoot, "escape")).rejects.toMatchObject({ code: "skill_not_found" });
	});
});
