// The vendor a model selector names. Pure, no Node imports: the server and the browser
// bundle share it (the check-routing editor lists the vendors the configured models use).
import { splitLevel } from "./levels.ts";

/** Model-id tokens that name a vendor, matched after the provider prefix is stripped: Claude
 *  via github-copilot, Bedrock, Vertex, OpenRouter or a gateway is still an Anthropic model.
 *  omp's model catalog cannot say: its entries carry `provider` — the prefix itself, exactly
 *  the signal that misleads — and no vendor field (checked against `omp models --json`). */
const VENDOR_TOKENS: Record<string, string> = {
	anthropic: "anthropic",
	claude: "anthropic",
	openai: "openai",
	gpt: "openai",
	codex: "openai",
	google: "google",
	gemini: "google",
	zai: "zai",
	zhipu: "zai",
	glm: "zai",
	xai: "xai",
	grok: "xai",
	deepseek: "deepseek",
	moonshot: "moonshot",
	kimi: "moonshot",
	meta: "meta",
	llama: "meta",
	mistral: "mistral",
	mixtral: "mistral",
	ministral: "mistral",
	codestral: "mistral",
	magistral: "mistral",
	pixtral: "mistral",
	devstral: "mistral",
	qwen: "qwen",
	alibaba: "qwen",
	tongyi: "qwen",
	cohere: "cohere",
	command: "cohere",
	amazon: "amazon",
	nova: "amazon",
	titan: "amazon",
};
/** OpenAI's o-series ids ("o4-mini"): the family prefix is the bare letter and a number. */
const O_SERIES = /^o\d+$/;

/** The vendor a model selector names, read from the model id after the provider prefix; the
 *  id may carry its own vendor path (OpenRouter's "openrouter/anthropic/claude-x") or dotted
 *  qualifiers (Bedrock's "bedrock/us.anthropic.claude-x"), so every separator-separated token
 *  is tried in order and the first known one decides. Null when no known token shows up.
 *  The `:level` thinking suffix is ignored. Pure. */
export function modelVendor(selector: string): string | null {
	const [base] = splitLevel(selector);
	const slash = base.indexOf("/");
	const id = slash === -1 ? base : base.slice(slash + 1);
	for (const token of id.toLowerCase().split(/[./_-]+/)) {
		if (O_SERIES.test(token)) return "openai";
		// hasOwn, not a bare member read: an id may hold any token, and "constructor"
		// must stay an unknown vendor, not Object.prototype's.
		if (Object.hasOwn(VENDOR_TOKENS, token))
			return VENDOR_TOKENS[token] as string;
	}
	return null;
}
