import { isAllowedModel, type Publisher } from './guard.ts';

/** USD per 1M tokens. */
export interface Pricing { input: number; output: number; cacheRead?: number; cacheWrite?: number }

export interface ModelSpec {
  id: string;
  name: string;
  publisher: Publisher;
  maxInput: number;
  maxOutput: number;
  pricing?: Pricing;
}

// List prices for the Vertex global endpoint as of 2026-11. Regional endpoints may cost more;
// override in settings (vertexCopilot.extraModels) if your contract differs.
const BUILTIN: ModelSpec[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', publisher: 'anthropic', maxInput: 1_000_000, maxOutput: 128_000, pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', publisher: 'anthropic', maxInput: 1_000_000, maxOutput: 128_000, pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', publisher: 'anthropic', maxInput: 1_000_000, maxOutput: 128_000, pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', publisher: 'anthropic', maxInput: 1_000_000, maxOutput: 128_000, pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', publisher: 'anthropic', maxInput: 1_000_000, maxOutput: 128_000, pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', publisher: 'anthropic', maxInput: 1_000_000, maxOutput: 64_000, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', publisher: 'google', maxInput: 1_048_576, maxOutput: 65_536, pricing: { input: 2, output: 12, cacheRead: 0.2 } },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', publisher: 'google', maxInput: 1_048_576, maxOutput: 65_536, pricing: { input: 1.5, output: 9, cacheRead: 0.15 } },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', publisher: 'google', maxInput: 1_048_576, maxOutput: 65_536, pricing: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', publisher: 'google', maxInput: 1_048_576, maxOutput: 65_536, pricing: { input: 0.3, output: 2.5, cacheRead: 0.03 } },
];

export interface ExtraModelSetting { id: string; name?: string; inputPer1M?: number; outputPer1M?: number; cacheReadPer1M?: number; maxInputTokens?: number; maxOutputTokens?: number }

/** Built-ins plus user-added models; anything not passing the allowlist is silently dropped. */
export function buildCatalog(extra: readonly ExtraModelSetting[] = []): ModelSpec[] {
  const out = new Map(BUILTIN.map(m => [m.id, m]));
  for (const e of extra) {
    if (typeof e?.id !== 'string') continue;
    const publisher: Publisher = e.id.startsWith('claude-') ? 'anthropic' : 'google';
    if (!isAllowedModel(publisher, e.id)) continue;
    const base = out.get(e.id);
    const priced = typeof e.inputPer1M === 'number' && typeof e.outputPer1M === 'number';
    out.set(e.id, {
      id: e.id,
      name: e.name ?? base?.name ?? e.id,
      publisher,
      maxInput: e.maxInputTokens ?? base?.maxInput ?? 200_000,
      maxOutput: e.maxOutputTokens ?? base?.maxOutput ?? 32_000,
      pricing: priced ? { input: e.inputPer1M!, output: e.outputPer1M!, cacheRead: e.cacheReadPer1M } : base?.pricing,
    });
  }
  return [...out.values()];
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Returns undefined when the model has no known pricing. `input` excludes cached tokens. */
export function costOf(p: Pricing | undefined, u: Usage): number | undefined {
  if (!p) return undefined;
  return (u.input * p.input + u.output * p.output + u.cacheRead * (p.cacheRead ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}
