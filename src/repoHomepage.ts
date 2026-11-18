import { runGh } from "./release.ts";
import type { ProjectHomepage } from "./types.ts";

const HOMEPAGE_TTL = 10 * 60_000;
const homepageCache = new Map<
	string,
	{ at: number; value: ProjectHomepage | null }
>();
const homepageRequests = new Map<string, Promise<ProjectHomepage | null>>();

/** Read and normalize the root homepage field in a GitHub repository response. */
export function parseRepoHomepage(body: unknown): ProjectHomepage | null {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return null;
	if (!("homepage" in body)) return null;
	const homepage = body.homepage;
	if (typeof homepage !== "string") return null;
	const trimmed = homepage.trim();
	if (trimmed === "" || !/^https?:\/\/[^/\\?#]+/i.test(trimmed)) return null;

	try {
		const url = new URL(trimmed);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.hostname === "" ||
			url.username !== "" ||
			url.password !== ""
		)
			return null;
		return { url: url.href, domain: url.hostname };
	} catch {
		return null;
	}
}

/** Fetch and parse the homepage from the GitHub repository endpoint. */
export async function repositoryHomepage(
	repo: string,
	gh: typeof runGh = runGh,
): Promise<ProjectHomepage | null> {
	const response = await gh(["api", "--method", "GET", `repos/${repo}`]);
	if (response.code !== 0) throw new Error("GitHub repository request failed");
	const body: unknown = JSON.parse(response.stdout);
	return parseRepoHomepage(body);
}

/** Return a per-repository homepage cache, sharing probes and preserving a good value on failure. */
export async function cachedRepoHomepage(
	repo: string,
	gh: typeof runGh = runGh,
): Promise<ProjectHomepage | null> {
	const cached = homepageCache.get(repo);
	if (cached !== undefined && Date.now() - cached.at < HOMEPAGE_TTL)
		return cached.value;

	const active = homepageRequests.get(repo);
	if (active !== undefined) return active;

	const request = repositoryHomepage(repo, gh)
		.catch(() => homepageCache.get(repo)?.value ?? null)
		.then((value) => {
			homepageCache.set(repo, { at: Date.now(), value });
			return value;
		})
		.finally(() => {
			homepageRequests.delete(repo);
		});
	homepageRequests.set(repo, request);
	return request;
}
