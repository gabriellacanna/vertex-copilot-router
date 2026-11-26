import * as vscode from 'vscode';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { guardedFetch } from './guard.ts';
import { Memo, SYSTEM_ROLE, textOf, type Streamer } from './vertex.ts';

// VS Code messages can't carry thinking blocks, but Claude needs them replayed unchanged
// alongside the tool_use they preceded. Keyed by the first tool_use id of that turn.
const thinkingByCall = new Memo<Anthropic.ContentBlockParam[]>();

function toClaude(msgs: readonly vscode.LanguageModelChatRequestMessage[]) {
  let system = '';
  const messages: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    if ((m.role as number) === SYSTEM_ROLE) { system += textOf(m.content); continue; }
    const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const blocks: Anthropic.ContentBlockParam[] = [];
    let firstCall: string | undefined;
    for (const p of m.content) {
      if (p instanceof vscode.LanguageModelTextPart) { if (p.value) blocks.push({ type: 'text', text: p.value }); }
      else if (p instanceof vscode.LanguageModelToolCallPart) {
        firstCall ??= p.callId;
        blocks.push({ type: 'tool_use', id: p.callId, name: p.name, input: p.input });
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        blocks.push({ type: 'tool_result', tool_use_id: p.callId, content: textOf(p.content) || '(no output)' });
      }
    }
    if (role === 'assistant' && firstCall) blocks.unshift(...(thinkingByCall.get(firstCall) ?? []));
    if (blocks.length) messages.push({ role, content: blocks });
  }
  return { system, messages };
}

export const streamClaude: Streamer = async ({ ctx, model, messages, tools, progress, signal, maxTokens }) => {
  const client = new AnthropicVertex({
    projectId: ctx.project, region: ctx.location, googleAuth: ctx.auth,
    baseURL: `https://${ctx.host}/v1`, // explicit, so ANTHROPIC_VERTEX_BASE_URL can't redirect traffic
    fetch: guardedFetch,
  });
  const { system, messages: msgs } = toClaude(messages);
  // tool_choice is left "auto": current Claude models reject forced tool use.
  const stream = client.messages.stream({
    model: model.id,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: msgs,
    ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema })) } : {}),
    cache_control: { type: 'ephemeral' },
  }, { signal });

  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') progress.report(new vscode.LanguageModelTextPart(ev.delta.text));
  }
  const final = await stream.finalMessage();
  const thinking = final.content.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking') as Anthropic.ContentBlockParam[];
  const calls = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (calls.length && thinking.length) thinkingByCall.set(calls[0].id, thinking);
  for (const c of calls) progress.report(new vscode.LanguageModelToolCallPart(c.id, c.name, (c.input ?? {}) as object));
  if (final.stop_reason === 'refusal') progress.report(new vscode.LanguageModelTextPart('\n\n_[Claude declined this request.]_'));

  const u = final.usage;
  return { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
};
