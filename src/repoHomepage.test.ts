import { describe, expect, spyOn, test } from "bun:test";
import { delimiter, join } from "node:path";
import {
	cachedRepoHomepage,
	parseRepoHomepage,
	repositoryHomepage,
} from "./repoHomepage.ts";
import fc from "./test/properties.ts";

const validHomepage = {
	url: "https://example.com/project",
	domain: "example.com",
};

type GhReply = { code: number; stdout: string; stderr: string };
type Gh = (args: string[]) => Promise<GhReply>;

const reply = (body: unknown): GhReply => ({
	code: 0,
	stdout: JSON.stringify(body),
	stderr: "",
});

describe("repository homepage", () => {
	test("reads the root homepage field from the repository response", async () => {
		const requests: string[][] = [];
		const gh: Gh = async (args) => {
			requests.push(args);
			return reply({
				id: 42,
				full_name: "owner/project",
				homepage: "https://example.com/project",
				organization: { homepage: "https://wrong.example/" },
			});
		};

		expect(await repositoryHomepage("owner/project", gh)).toEqual(
			validHomepage,
		);
		expect(requests).toEqual([
			["api", "--method", "GET", "repos/owner/project"],
		]);
	});

	test("reads through the real gh runner", async () => {
		if (process.platform === "win32") return;
		const savedPath = process.env.PATH;
		const savedHost = process.env.OTTR_GITHUB_HOST;
		const savedToken = process.env.GH_TOKEN;
		const savedEnterpriseToken = process.env.GH_ENTERPRISE_TOKEN;
		try {
			const bin = join(import.meta.dir, "test");
			process.env.PATH = savedPath ? `${bin}${delimiter}${savedPath}` : bin;
			process.env.OTTR_GITHUB_HOST = "";
			delete process.env.GH_TOKEN;
			delete process.env.GH_ENTERPRISE_TOKEN;
			expect(await cachedRepoHomepage("owner/project")).toEqual(validHomepage);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			if (savedHost === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = savedHost;
			if (savedToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = savedToken;
			if (savedEnterpriseToken === undefined)
				delete process.env.GH_ENTERPRISE_TOKEN;
			else process.env.GH_ENTERPRISE_TOKEN = savedEnterpriseToken;
		}
	});

	test("rejects missing, invalid, non-HTTP, hostless, and credential URLs", () => {
		for (const body of [
			null,
			{},
			{ homepage: "" },
			{ homepage: "   " },
			{ homepage: "not a url" },
			{ homepage: "ftp://example.com/project" },
			{ homepage: "http:///path" },
			{ homepage: "http://" },
			{ homepage: "http:example.com" },
			{ homepage: "https://user@example.com/" },
			{ homepage: "https://user:pass@example.com/" },
			{ homepage: 42 },
		]) {
			expect(parseRepoHomepage(body)).toBeNull();
		}
	});

	test("normalizes accepted HTTP and HTTPS URLs", () => {
		expect(
			parseRepoHomepage({ homepage: "HTTP://Example.COM:80/path" }),
		).toEqual({
			url: "http://example.com/path",
			domain: "example.com",
		});
		expect(
			parseRepoHomepage({ homepage: "https://example.com:443/path" }),
		).toEqual({
			url: "https://example.com/path",
			domain: "example.com",
		});
	});

	test("keeps malformed JSON and failed requests distinct from no homepage", async () => {
		await expect(
			repositoryHomepage("owner/project", async () => ({
				code: 0,
				stdout: "{",
				stderr: "",
			})),
		).rejects.toThrow();
		await expect(
			repositoryHomepage("owner/project", async () => ({
				code: 1,
				stdout: "",
				stderr: "request failed",
			})),
		).rejects.toThrow();
		expect(
			await repositoryHomepage("owner/project", async () =>
				reply({ homepage: "" }),
			),
		).toBeNull();
	});

	test("property: accepted homepages are safe normalized URLs", () => {
		fc.assert(
			fc.property(fc.string(), (homepage) => {
				const parsed = parseRepoHomepage({ homepage });
				if (parsed === null) return;
				const url = new URL(parsed.url);
				expect(["http:", "https:"]).toContain(url.protocol);
				expect(url.hostname).not.toBe("");
				expect(url.username).toBe("");
				expect(url.password).toBe("");
				expect(parsed.domain).toBe(url.hostname);
			}),
		);
	});

	test("property: parsing arbitrary input never throws", () => {
		fc.assert(
			fc.property(fc.anything(), (body) => {
				expect(() => parseRepoHomepage(body)).not.toThrow();
			}),
		);
	});

	test("shares one in-flight repository request", async () => {
		const repo = `homepage-flight-${crypto.randomUUID()}`;
		let calls = 0;
		const { promise, resolve } = Promise.withResolvers<GhReply>();
		const gh: Gh = async () => {
			calls += 1;
			return promise;
		};
		const first = cachedRepoHomepage(repo, gh);
		const second = cachedRepoHomepage(repo, gh);
		expect(calls).toBe(1);
		resolve(reply({ homepage: "https://example.com/project" }));
		expect(await Promise.all([first, second])).toEqual([
			validHomepage,
			validHomepage,
		]);
	});

	test("reuses cached values, refreshes after ten minutes, and keeps the last good value on failure", async () => {
		const now = spyOn(Date, "now").mockReturnValue(1_000_000);
		const repo = `homepage-cache-${crypto.randomUUID()}`;
		let calls = 0;
		const gh: Gh = async () => {
			calls += 1;
			if (calls === 1)
				return reply({ homepage: "https://example.com/project" });
			if (calls === 2)
				return reply({ homepage: "https://new.example/project" });
			throw new Error("GitHub request failed");
		};
		try {
			expect(await cachedRepoHomepage(repo, gh)).toEqual(validHomepage);
			expect(await cachedRepoHomepage(repo, gh)).toEqual(validHomepage);
			expect(calls).toBe(1);

			now.mockReturnValue(1_000_000 + 10 * 60_000);
			expect(await cachedRepoHomepage(repo, gh)).toEqual({
				url: "https://new.example/project",
				domain: "new.example",
			});
			expect(calls).toBe(2);

			now.mockReturnValue(1_000_000 + 20 * 60_000);
			expect(await cachedRepoHomepage(repo, gh)).toEqual({
				url: "https://new.example/project",
				domain: "new.example",
			});
			expect(calls).toBe(3);
		} finally {
			now.mockRestore();
		}
	});
});
