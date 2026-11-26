// Single chokepoint for every outbound HTTP request the extension makes.
// RULE: only Google (Gemini) and Anthropic (Claude) models may ever be called or pinged.
// Anything not matching the allowlist below is rejected before a socket is opened.

export type Publisher = 'google' | 'anthropic';

const MODEL_ID: Record<Publisher, RegExp> = {
  google: /^gemini-[a-z0-9][a-z0-9.-]*$/,
  anthropic: /^claude-[a-z0-9][a-z0-9.-]*(@\d{8})?$/,
};

// Defense in depth: even a name that slipped past the allowlist is refused if it mentions these.
const DENY = /qwen|deepseek|kimi|moonshot|glm|zhipu|chatglm|minimax|baichuan|ernie|hunyuan|doubao|internlm|stepfun|01-ai|\byi-|sensenova|spark|iflytek|tencent|alibaba|baidu|bytedance/i;

export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const LOCATION = /^(global|[a-z]+-[a-z]+[0-9]+)$/;

const AIPLATFORM_HOST = /^(?:[a-z]+-[a-z]+[0-9]+-)?aiplatform\.googleapis\.com$/;
const MODEL_CALL = /^\/v1(?:beta1)?\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/([^/]+)\/models\/([^/:]+):(streamRawPredict|rawPredict|streamGenerateContent|generateContent)$/;
// Catalog listing (no inference) is allowed only for the two permitted publishers.
const CATALOG = /^\/v1beta1\/publishers\/(google|anthropic)\/models$/;

export class BlockedRequestError extends Error {}

export function isAllowedModel(publisher: string, modelId: string): publisher is Publisher {
  if (publisher !== 'google' && publisher !== 'anthropic') return false;
  return MODEL_ID[publisher].test(modelId) && !DENY.test(modelId);
}

export function assertAllowedUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedRequestError(`Blocked malformed URL`); }
  const block = (why: string) => { throw new BlockedRequestError(`Blocked request to ${u.host}${u.pathname}: ${why}`); };
  if (u.protocol !== 'https:' || u.username || u.password || u.port) block('must be plain https');

  if (u.host === 'cloudresourcemanager.googleapis.com') {
    if (u.pathname !== '/v3/projects:search') block('only project search is allowed');
    return;
  }
  if (!AIPLATFORM_HOST.test(u.host)) block('host not allowed');

  if (CATALOG.test(u.pathname)) return;
  const m = MODEL_CALL.exec(u.pathname);
  if (!m) block('only Gemini/Claude model endpoints are allowed');
  const [, project, location, publisher, model] = m!;
  if (!PROJECT_ID.test(project) || !LOCATION.test(location)) block('invalid project or location');
  if (!isAllowedModel(publisher, decodeURIComponent(model))) block(`model "${publisher}/${model}" is not allowlisted`);
  if (u.search && u.search !== '?alt=sse') block('unexpected query');
}

/** fetch() that refuses anything outside the allowlist and never follows redirects. */
export const guardedFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  assertAllowedUrl(url);
  return fetch(input, { ...init, redirect: 'error' });
};
