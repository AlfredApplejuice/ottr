/** Apply this filter after all child environment merges. */
export function childDatabaseEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const env = { ...base };
	delete env.OTTR_DATABASE_URL;
	return env;
}
