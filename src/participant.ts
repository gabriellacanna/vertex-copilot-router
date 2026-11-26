import * as vscode from 'vscode';
import { isAllowedModel } from './guard.ts';
import type { ModelSpec, Usage } from './catalog.ts';
import { costOf } from './catalog.ts';
import { catalog, cfg, explain, SYSTEM_ROLE, vertexCtx, type Streamer } from './vertex.ts';
import type { CostTracker } from './costs.ts';

// @vertex talks to Vertex directly, so it works in Local chat even where BYOK model providers are disabled.
// It can still use Copilot's agent tools through vscode.lm.invokeTool (with Copilot's own confirmations).

const FOOTER = '\n\n---\n*Vertex ·';
const MAX_TOOL_ROUNDS = 25;
const MAX_REF_CHARS = 100_000;
const SYSTEM = 'You are @vertex, a coding assistant inside VS Code, running on the user\'s Google Cloud Vertex AI project. '
  + 'Answer concisely in Markdown. Use the available tools to read or change the workspace when that helps.';

const k = (n: number) => (n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

async function referenceText(ref: vscode.ChatPromptReference): Promise<string> {
  const v = ref.value;
  try {
    if (v instanceof vscode.Uri) {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(v)).slice(0, MAX_REF_CHARS);
      return `<file path="${vscode.workspace.asRelativePath(v)}">\n${text}\n</file>`;
    }
    if (v instanceof vscode.Location) {
      const doc = await vscode.workspace.openTextDocument(v.uri);
      return `<selection path="${vscode.workspace.asRelativePath(v.uri)}" lines="${v.range.start.line + 1}-${v.range.end.line + 1}">\n${doc.getText(v.range).slice(0, MAX_REF_CHARS)}\n</selection>`;
    }
    if (typeof v === 'string') return `<reference id="${ref.id}">\n${v.slice(0, MAX_REF_CHARS)}\n</reference>`;
  } catch { /* unreadable reference: skip it */ }
  return '';
}

function history(ctx: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const turn of ctx.history) {
    if (turn instanceof vscode.ChatRequestTurn) out.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response.map(r => (r instanceof vscode.ChatResponseMarkdownPart ? r.value.value : '')).join('').split(FOOTER)[0];
      if (text) out.push(vscode.LanguageModelChatMessage.Assistant(text));
    }
  }
  return out;
}

export function createVertexParticipant(costs: CostTracker, streamerFor: (m: ModelSpec) => Streamer): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
    if (request.command === 'model') {
      await vscode.commands.executeCommand('vertexCopilot.selectParticipantModel');
      stream.markdown(`@vertex now uses **${cfg().get('participant.model')}**.`);
      return {};
    }
    const id = cfg().get<string>('participant.model', 'claude-opus-5-5');
    const model = catalog().find(m => m.id === id);
    if (!model || !isAllowedModel(model.publisher, model.id)) return { errorDetails: { message: `Model "${id}" is not available. Use /model to pick one.` } };

    const refs = (await Promise.all(request.references.map(referenceText))).filter(Boolean).join('\n\n');
    const messages: vscode.LanguageModelChatMessage[] = [
      new vscode.LanguageModelChatMessage(SYSTEM_ROLE as vscode.LanguageModelChatMessageRole, SYSTEM),
      ...history(chatCtx),
      vscode.LanguageModelChatMessage.User(refs ? `${refs}\n\n${request.prompt}` : request.prompt),
    ];
    // #tool references narrow the set; otherwise offer every registered tool.
    // shortcut: capped at 128 (Gemini's function limit), pick by relevance if users hit it.
    const picked = request.toolReferences.length ? vscode.lm.tools.filter(t => request.toolReferences.some(r => r.name === t.name)) : vscode.lm.tools;
    const tools = picked.slice(0, 128).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const ctx = await vertexCtx();
      for (let round = 0; round < MAX_TOOL_ROUNDS && !token.isCancellationRequested; round++) {
        let text = '';
        const calls: vscode.LanguageModelToolCallPart[] = [];
        const usage = await streamerFor(model)({
          ctx, model, messages, tools, toolMode: vscode.LanguageModelChatToolMode.Auto, signal: ac.signal,
          maxTokens: Math.min(model.maxOutput, 64_000),
          progress: { report: p => {
            if (p instanceof vscode.LanguageModelTextPart) { text += p.value; stream.markdown(p.value); }
            else if (p instanceof vscode.LanguageModelToolCallPart) calls.push(p);
          } },
        });
        for (const f of Object.keys(total) as (keyof Usage)[]) total[f] += usage[f];
        await costs.record(model, usage);
        if (!calls.length) break;

        messages.push(vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]));
        const results: vscode.LanguageModelToolResultPart[] = [];
        for (const c of calls) {
          stream.progress(`Running ${c.name}…`);
          try {
            const r = await vscode.lm.invokeTool(c.name, { input: c.input, toolInvocationToken: request.toolInvocationToken }, token);
            results.push(new vscode.LanguageModelToolResultPart(c.callId, r.content));
          } catch (err) {
            results.push(new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart(`Tool failed: ${err instanceof Error ? err.message : err}`)]));
          }
        }
        messages.push(vscode.LanguageModelChatMessage.User(results));
        if (text) stream.markdown('\n\n');
      }
      const cost = costOf(model.pricing, total);
      stream.markdown(`${FOOTER} ${model.name} · ${k(total.input + total.cacheRead + total.cacheWrite)} in / ${k(total.output)} out · ${cost === undefined ? 'price unknown' : `$${cost.toFixed(4)}`}*`);
      return {};
    } catch (err) {
      if (token.isCancellationRequested) return {};
      return { errorDetails: { message: explain(err) } };
    } finally { sub.dispose(); }
  };

  const participant = vscode.chat.createChatParticipant('vertexCopilot.vertex', handler);
  participant.iconPath = new vscode.ThemeIcon('cloud');
  return participant;
}
