import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { guardedFetch } from './guard.ts';
import { authHeaders, Memo, SYSTEM_ROLE, textOf, type Streamer } from './vertex.ts';

// Gemini 3 rejects function-call history without the thoughtSignature it originally returned.
const sigByCall = new Memo<string>();

function toGemini(msgs: readonly vscode.LanguageModelChatRequestMessage[]) {
  let system = '';
  const names = new Map<string, string>();
  const contents: any[] = [];
  for (const m of msgs) {
    if ((m.role as number) === SYSTEM_ROLE) { system += textOf(m.content); continue; }
    const parts: any[] = [];
    for (const p of m.content) {
      if (p instanceof vscode.LanguageModelTextPart) { if (p.value) parts.push({ text: p.value }); }
      else if (p instanceof vscode.LanguageModelToolCallPart) {
        names.set(p.callId, p.name);
        const sig = sigByCall.get(p.callId);
        parts.push({ functionCall: { name: p.name, args: p.input }, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        parts.push({ functionResponse: { name: names.get(p.callId) ?? 'tool', response: { content: textOf(p.content) } } });
      }
    }
    if (parts.length) contents.push({ role: m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user', parts });
  }
  return { system, contents };
}

export const streamGemini: Streamer = async ({ ctx, model, messages, tools, toolMode, progress, signal, maxTokens }) => {
  const { system, contents } = toGemini(messages);
  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools.length ? {
      tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema ?? { type: 'object', properties: {} } })) }],
      ...(toolMode === vscode.LanguageModelChatToolMode.Required ? { toolConfig: { functionCallingConfig: { mode: 'ANY' } } } : {}),
    } : {}),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const url = `https://${ctx.host}/v1/projects/${ctx.project}/locations/${ctx.location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
  const res = await guardedFetch(url, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`Vertex Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  let usage: any = {};
  let buf = '';
  const decoder = new TextDecoder();
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const chunk = JSON.parse(line.slice(5));
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (part.thought) continue;
      if (part.text) progress.report(new vscode.LanguageModelTextPart(part.text));
      if (part.functionCall) {
        const id = `call_${randomUUID().replace(/-/g, '')}`;
        if (part.thoughtSignature) sigByCall.set(id, part.thoughtSignature);
        progress.report(new vscode.LanguageModelToolCallPart(id, part.functionCall.name, part.functionCall.args ?? {}));
      }
    }
  };
  for await (const bytes of res.body) {
    buf += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
  }
  handle(buf.trim());

  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    input: (usage.promptTokenCount ?? 0) - cached,
    output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), // thinking is billed as output
    cacheRead: cached,
    cacheWrite: 0,
  };
};
