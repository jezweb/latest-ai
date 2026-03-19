// Latest AI Models — models.flared.au
// Fetches from OpenRouter API, filters to leading models, serves in 3 formats.

const PROVIDERS = [
	'anthropic',
	'openai',
	'google',
	'meta-llama',
	'mistralai',
	'deepseek',
	'qwen',
	'x-ai',
	'z-ai',
	'cohere',
	'nvidia',
] as const;

const DEFAULT_DAYS = 90;
const CACHE_TTL = 21600; // 6 hours in seconds
const OPENROUTER_API = 'https://openrouter.ai/api/v1/models';

// Flagship families: latest model matching each pattern is always included,
// regardless of recency cutoff. Patterns match against the part after "provider/".
const FLAGSHIPS: Record<string, string[]> = {
	anthropic: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
	openai: ['gpt-.*-pro', 'gpt-(?!.*(?:pro|mini|codex|chat|audio))[\\d.]+$', 'gpt-.*-mini', 'gpt-.*-codex(?!-)'],
	google: ['gemini-.*-pro-preview$', 'gemini-.*-flash(?!.*lite)(?!.*image)-preview$', 'gemini-.*-flash-lite'],
	mistralai: ['mistral-large', 'mistral-medium', 'mistral-small(?!.*creative)', 'ministral-\\d+b'],
	deepseek: ['deepseek-v3', 'deepseek-r1(?!-)'],
	'meta-llama': ['llama-4', 'llama-3\\.3', 'llama-3\\.2-.*vision'],
	'x-ai': ['grok-\\d+(?!.*(?:fast|mini|beta))', 'grok-.*-fast(?!.*beta)'],
	'z-ai': ['glm-\\d+$', 'glm-.*-flash'],
	qwen: ['qwen.*-max', 'qwen.*-plus', 'qwen.*-flash(?!.*lite)'],
};

// Knowledge cutoff dates — manually maintained from provider docs.
// Keys are OpenRouter model ID prefixes (matched with startsWith after provider/).
// Values are "YYYY-MM" or "YYYY-MM-DD" strings.
const KNOWLEDGE_CUTOFFS: Record<string, string> = {
	// Anthropic — platform.claude.com/docs/en/docs/about-claude/models
	'anthropic/claude-opus-4.6': '2025-05',
	'anthropic/claude-sonnet-4.6': '2025-08',
	'anthropic/claude-opus-4.5': '2025-03',
	'anthropic/claude-sonnet-4.5': '2025-03',
	'anthropic/claude-opus-4': '2025-03',
	'anthropic/claude-sonnet-4': '2025-03',
	'anthropic/claude-haiku-4.5': '2025-02',
	// OpenAI — platform.openai.com/docs/models
	'openai/gpt-4.1': '2024-06',
	'openai/gpt-4.1-mini': '2024-06',
	'openai/gpt-4.1-nano': '2024-06',
	'openai/o3': '2024-06',
	'openai/o3-mini': '2023-10',
	'openai/gpt-4o': '2024-06',
	'openai/gpt-4o-mini': '2023-10',
	// Google — cloud.google.com/vertex-ai/generative-ai/docs/models
	'google/gemini-2.5-pro': '2025-01',
	'google/gemini-2.5-flash': '2025-01',
	'google/gemini-2.0-flash': '2024-06',
	// Meta — github.com/meta-llama/llama-models
	'meta-llama/llama-4': '2024-08',
	'meta-llama/llama-3.3': '2023-12',
	// xAI — docs.x.ai/developers/models
	'x-ai/grok-3': '2024-11',
	// DeepSeek — community-confirmed
	'deepseek/deepseek-v3': '2024-07',
	'deepseek/deepseek-r1': '2024-07',
	// Mistral — NVIDIA NIM model cards
	'mistralai/mistral-large': '2024-10',
	'mistralai/mistral-small': '2023-10',
};

// Direct API endpoints and model ID derivation rules per provider.
// Providers without a widely-used direct API are omitted — use OpenRouter for those.
const PROVIDER_APIS: Record<string, { url: string; transform?: (name: string) => string }> = {
	anthropic: { url: 'https://api.anthropic.com/v1/messages', transform: (n) => n.replace(/\./g, '-') },
	openai: { url: 'https://api.openai.com/v1/chat/completions' },
	google: { url: 'https://generativelanguage.googleapis.com/v1beta/models' },
	mistralai: { url: 'https://api.mistral.ai/v1/chat/completions' },
	deepseek: { url: 'https://api.deepseek.com/chat/completions' },
	'x-ai': { url: 'https://api.x.ai/v1/chat/completions' },
	qwen: { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions' },
	cohere: { url: 'https://api.cohere.com/v2/chat' },
};

function toApiId(openRouterId: string): string | null {
	const [provider, ...rest] = openRouterId.split('/');
	const name = rest.join('/');
	const api = PROVIDER_APIS[provider];
	if (!api) return null;
	return api.transform ? api.transform(name) : name;
}

function lookupKnowledgeCutoff(modelId: string): string | null {
	// Try exact match first, then prefix match (longest prefix wins)
	if (KNOWLEDGE_CUTOFFS[modelId]) return KNOWLEDGE_CUTOFFS[modelId];
	let bestMatch: string | null = null;
	let bestLen = 0;
	for (const key of Object.keys(KNOWLEDGE_CUTOFFS)) {
		if (modelId.startsWith(key) && key.length > bestLen) {
			bestMatch = KNOWLEDGE_CUTOFFS[key];
			bestLen = key.length;
		}
	}
	return bestMatch;
}

// --- Types ---

interface OpenRouterModel {
	id: string;
	name: string;
	created: number;
	context_length: number;
	pricing: { prompt: string; completion: string };
	architecture: { modality: string; input_modalities: string[]; output_modalities: string[] };
	top_provider?: { max_completion_tokens?: number };
}

interface FilteredModel {
	id: string;
	name: string;
	provider: string;
	api_id: string | null;
	context_length: number;
	max_output: number | null;
	pricing: { input: number; output: number };
	modality: string;
	released: string;
	knowledge_cutoff: string | null;
	flagship: boolean;
}

// --- Fetch & Filter ---

// Find the newest model ID matching each flagship pattern per provider
function findFlagshipIds(models: OpenRouterModel[]): Set<string> {
	const ids = new Set<string>();
	for (const [provider, patterns] of Object.entries(FLAGSHIPS)) {
		const providerModels = models.filter(
			(m) => m.id.split('/')[0] === provider && !m.id.includes(':free') && !m.id.includes(':extended')
		);
		for (const pattern of patterns) {
			const re = new RegExp(`^${pattern}`);
			const matches = providerModels.filter((m) => re.test(m.id.split('/')[1]));
			if (matches.length > 0) {
				// Pick the newest
				matches.sort((a, b) => b.created - a.created);
				ids.add(matches[0].id);
			}
		}
	}
	return ids;
}

async function fetchModels(days: number, providerFilter?: string): Promise<{ models: FilteredModel[]; updated: string }> {
	const resp = await fetch(OPENROUTER_API, { cf: { cacheTtl: CACHE_TTL } } as RequestInit);
	if (!resp.ok) throw new Error(`OpenRouter API error: ${resp.status}`);

	const data = (await resp.json()) as { data: OpenRouterModel[] };
	const cutoff = Date.now() / 1000 - days * 86400;
	const flagshipIds = findFlagshipIds(data.data);

	const filtered = data.data
		.filter((m) => {
			const provider = m.id.split('/')[0];
			if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) return false;
			if (providerFilter && provider !== providerFilter) return false;
			if (m.id.includes(':free')) return false;
			if (m.id.includes(':extended')) return false;
			if (m.pricing.prompt === '0' && m.pricing.completion === '0') return false;
			// Include if within recency window OR is a flagship
			if (m.created < cutoff && !flagshipIds.has(m.id)) return false;
			return true;
		})
		.map((m) => ({
			id: m.id,
			name: m.name,
			provider: m.id.split('/')[0],
			api_id: toApiId(m.id),
			context_length: m.context_length,
			max_output: m.top_provider?.max_completion_tokens ?? null,
			pricing: {
				input: parseFloat(m.pricing.prompt) * 1_000_000,
				output: parseFloat(m.pricing.completion) * 1_000_000,
			},
			modality: m.architecture?.modality ?? 'text->text',
			released: new Date(m.created * 1000).toISOString().split('T')[0],
			knowledge_cutoff: lookupKnowledgeCutoff(m.id),
			flagship: flagshipIds.has(m.id),
		}))
		.sort((a, b) => {
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			// Flagships first, then by price descending within each group
			if (a.flagship !== b.flagship) return a.flagship ? -1 : 1;
			return b.pricing.input - a.pricing.input;
		});

	return { models: filtered, updated: new Date().toISOString() };
}

// --- Formatters ---

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return `${n}`;
}

function formatPrice(perMillion: number): string {
	if (perMillion === 0) return 'Free';
	if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
	return `$${perMillion.toFixed(2)}`;
}

// --- Renderers ---

function renderText(models: FilteredModel[], updated: string, days: number): string {
	const lines: string[] = [
		'# Latest AI Models',
		`# Source: OpenRouter API | Updated: ${updated}`,
		`# Filter: ${PROVIDERS.length} providers, last ${days} days | Total: ${models.length} models`,
		`# URL: https://models.flared.au/llms.txt`,
		`# >>> = current flagship model for this provider tier`,
		'#',
		'# Direct API endpoints (for providers with public APIs):',
		...Object.entries(PROVIDER_APIS).map(([p, a]) => `#   ${p}: ${a.url}`),
		'# All models available via OpenRouter: https://openrouter.ai/api/v1/chat/completions',
		'',
	];

	let currentProvider = '';
	for (const m of models) {
		if (m.provider !== currentProvider) {
			currentProvider = m.provider;
			lines.push(`## ${currentProvider}`, '');
		}
		const flag = m.flagship ? '>>> ' : '    ';
		const ctx = formatTokens(m.context_length);
		const out = m.max_output ? ` | Output: ${formatTokens(m.max_output)}` : '';
		const cutoff = m.knowledge_cutoff ? ` | Cutoff: ${m.knowledge_cutoff}` : '';
		const apiId = m.api_id && m.api_id !== m.id.split('/')[1] ? ` (api: ${m.api_id})` : '';
		lines.push(`${flag}${m.id}  Context: ${ctx}${out}${cutoff} | ${m.modality}${apiId}`);
	}

	return lines.join('\n');
}

function renderJSON(models: FilteredModel[], updated: string, days: number): string {
	return JSON.stringify(
		{
			updated,
			filter: { providers: [...PROVIDERS], days },
			total: models.length,
			models,
		},
		null,
		2
	);
}

function renderHTML(models: FilteredModel[], updated: string, days: number): string {
	let rows = '';
	let currentProvider = '';

	for (const m of models) {
		if (m.provider !== currentProvider) {
			currentProvider = m.provider;
			rows += `<tr><td colspan="7" class="provider">${esc(currentProvider)}</td></tr>\n`;
		}
		const ctx = formatTokens(m.context_length);
		const out = m.max_output ? formatTokens(m.max_output) : '-';
		const cls = m.flagship ? ' class="flagship"' : '';
		const cutoff = m.knowledge_cutoff ?? '-';
		const apiId = m.api_id ?? '-';
		rows += `<tr${cls}>
<td class="id">${esc(m.id)}</td>
<td class="api-id">${esc(apiId)}</td>
<td>${ctx}</td>
<td>${out}</td>
<td>${formatPrice(m.pricing.input)} / ${formatPrice(m.pricing.output)}</td>
<td>${cutoff}</td>
<td>${m.released}</td>
</tr>\n`;
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latest AI Models</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0a0a;color:#e5e5e5;padding:2rem;max-width:1600px;margin:0 auto;font-size:12px}
h1{font-size:1.2rem;margin-bottom:.25rem;color:#fff}
.meta{color:#737373;margin-bottom:1.5rem;font-size:11px}
.meta a{color:#737373}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #262626;color:#a3a3a3;font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
td{padding:.3rem .6rem;border-bottom:1px solid #171717}
.provider{font-weight:700;color:#fff;padding-top:1rem;font-size:13px;border-bottom:1px solid #262626}
.id{color:#60a5fa}
.api-id{color:#a78bfa;font-size:11px}
.flagship td{background:#111;color:#fff}
.flagship .id{color:#93c5fd}
tr:hover td:not(.provider){background:#111}
</style>
</head>
<body>
<h1>Latest AI Models</h1>
<p class="meta">Source: OpenRouter API | Updated: ${esc(updated)} | ${models.length} models, last ${days} days<br>
<a href="/llms.txt">llms.txt</a> · <a href="/json">JSON</a></p>
<table>
<thead><tr><th>Model ID</th><th>API ID</th><th>Context</th><th>Output</th><th>Pricing (per 1M)</th><th>Knowledge Cutoff</th><th>Released</th></tr></thead>
<tbody>
${rows}</tbody>
</table>
</body>
</html>`;
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Handler ---

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '') || DEFAULT_DAYS, 1), 365);
		const providerFilter = url.searchParams.get('provider') || undefined;

		try {
			const { models, updated } = await fetchModels(days, providerFilter);
			const headers = { 'Cache-Control': `public, max-age=${CACHE_TTL}` };
			const path = url.pathname;

			if (path === '/llms.txt') {
				return new Response(renderText(models, updated, days), {
					headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
				});
			}

			if (path === '/json') {
				return new Response(renderJSON(models, updated, days), {
					headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
				});
			}

			// Default: HTML
			return new Response(renderHTML(models, updated, days), {
				headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
			});
		} catch (err) {
			console.error(JSON.stringify({ event: 'fetch_error', error: String(err) }));
			return new Response('Service temporarily unavailable', { status: 502 });
		}
	},
} satisfies ExportedHandler;
