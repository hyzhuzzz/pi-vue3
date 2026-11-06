import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HttpError } from "./errors.js";

function isWithin(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return relativePath !== ".."
		&& !relativePath.startsWith(`..${sep}`)
		&& !isAbsolute(relativePath);
}

export async function readSkill(skillRoot: string, name: string): Promise<string> {
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
		throw new HttpError(404, "skill_not_found", "That Skill is not available.");
	}

	try {
		const root = await realpath(skillRoot);
		const skillFile = await realpath(resolve(root, name, "SKILL.md"));
		if (!isWithin(root, skillFile) || relative(root, skillFile).split(sep).length !== 2) {
			throw new Error("outside allowed Skill root");
		}
		return await readFile(skillFile, "utf8");
	} catch {
		throw new HttpError(404, "skill_not_found", "That Skill is not available.");
	}
}
