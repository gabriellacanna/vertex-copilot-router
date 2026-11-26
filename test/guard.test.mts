import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedUrl, isAllowedModel, BlockedRequestError } from '../src/guard.ts';
import { buildCatalog, costOf } from '../src/catalog.ts';

const base = 'https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/publishers';

test('allows Claude and Gemini inference endpoints', () => {
  assertAllowedUrl(`${base}/anthropic/models/claude-opus-5-5:streamRawPredict`);
  assertAllowedUrl(`${base}/anthropic/models/claude-opus-4-5@20251101:rawPredict`);
  assertAllowedUrl(`${base}/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse`);
  assertAllowedUrl('https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj-123/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict');
  assertAllowedUrl('https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=200');
  assertAllowedUrl('https://cloudresourcemanager.googleapis.com/v3/projects:search');
});

test('blocks every non-Google/Anthropic model, including Chinese models on Vertex MaaS', () => {
  const blocked = [
    `${base}/qwen/models/qwen3-coder:streamRawPredict`,
    `${base}/deepseek-ai/models/deepseek-r1:rawPredict`,
    `${base}/moonshotai/models/kimi-k2:rawPredict`,
    `${base}/zai-org/models/glm-4.6:rawPredict`,
    `${base}/minimaxai/models/minimax-m2:rawPredict`,
    `${base}/meta/models/llama-4:rawPredict`,
    `${base}/mistralai/models/mistral-large:rawPredict`,
    `${base}/google/models/qwen-on-google:generateContent`,       // wrong prefix under google
    `${base}/google/models/gemini-qwen-mix:generateContent`,       // deny-list catches smuggled names
    `${base}/anthropic/models/count-tokens:rawPredict`,
    `${base}/google/models/gemma-3:generateContent`,               // open weights, not Gemini
    'https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/endpoints/openapi/chat/completions', // OpenAI-compat MaaS gateway
    'https://aiplatform.googleapis.com/v1beta1/publishers/qwen/models',
    'https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/endpoints/123:predict',
    'https://evil.example.com/v1/projects/my-proj-123/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict',
    'https://aiplatform.googleapis.com.evil.com/v1/x',
    'http://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict',
    `${base}/anthropic/models/claude-opus-5-5:rawPredict?alt=sse&key=x`,
    `${base}/anthropic/models/claude-opus-5-5%2F..%2Fqwen:rawPredict`,
    'https://aiplatform.googleapis.com/v1/projects/BAD_ID/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict',
  ];
  for (const u of blocked) assert.throws(() => assertAllowedUrl(u), BlockedRequestError, u);
});

test('isAllowedModel', () => {
  assert.ok(isAllowedModel('anthropic', 'claude-haiku-5-5'));
  assert.ok(isAllowedModel('google', 'gemini-2.5-flash'));
  for (const [p, id] of [['google', 'claude-x'], ['anthropic', 'gemini-x'], ['qwen', 'qwen3'], ['google', 'gemini-deepseek'], ['anthropic', 'claude-glm']])
    assert.equal(isAllowedModel(p, id), false, `${p}/${id}`);
});

test('extra models outside the allowlist are dropped from the catalog', () => {
  const ids = buildCatalog([{ id: 'qwen3-coder' }, { id: 'deepseek-v3' }, { id: 'gemini-9-ultra', inputPer1M: 1, outputPer1M: 2 }, { id: 'claude-x-deepseek' }]).map(m => m.id);
  assert.ok(ids.includes('gemini-9-ultra'));
  assert.ok(!ids.some(id => /qwen|deepseek/.test(id)));
});

test('costOf', () => {
  assert.ok(Math.abs(costOf({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })! - 29.2) < 1e-9);
  assert.equal(costOf(undefined, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
});
