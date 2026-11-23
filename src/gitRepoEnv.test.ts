import { describe, expect, test } from "bun:test";
import {
	fixtureGitEnv,
	GIT_REPO_ENV,
	stripRepoRelocatingEnv,
} from "./gitRepoEnv.ts";

describe("gitRepoEnv (OTTR-1162)", () => {
	test("fixtureGitEnv keeps the ambient env minus the repo-relocating vars", () => {
		const saved: Record<string, string | undefined> = {};
		for (const k of GIT_REPO_ENV) {
			saved[k] = process.env[k];
			process.env[k] = "/workspace/ottr/.git";
		}
		process.env.OTTR_PROBE_KEEP = "keep";
		try {
			const env = fixtureGitEnv();
			for (const k of GIT_REPO_ENV) expect(env[k]).toBeUndefined();
			expect(env.OTTR_PROBE_KEEP).toBe("keep");
		} finally {
			for (const k of GIT_REPO_ENV) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k] as string;
			}
			delete process.env.OTTR_PROBE_KEEP;
		}
	});

	test("stripRepoRelocatingEnv deletes the vars in place and keeps the rest", () => {
		const env: Record<string, string | undefined> = {
			GIT_DIR: "/workspace/ottr/.git",
			GIT_COMMON_DIR: "/workspace/ottr/.git",
			KEEP: "y",
		};
		stripRepoRelocatingEnv(env);
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_COMMON_DIR).toBeUndefined();
		expect(env.KEEP).toBe("y");
	});
});
