import * as vscode from 'vscode';
import { isAllowedModel, LOCATION, PROJECT_ID } from './guard.ts';
import type { ExtraModelSetting, ModelSpec } from './catalog.ts';
import { catalog, cfg, listPublisherModels, searchProjects, vertexCtx, type Streamer } from './vertex.ts';
import { streamClaude } from './claude.ts';
import { streamGemini } from './gemini.ts';
import { CostTracker } from './costs.ts';

const log = vscode.window.createOutputChannel('Vertex Copilot', { log: true });
const streamerFor = (m: ModelSpec): Streamer => (m.publisher === 'anthropic' ? streamClaude : streamGemini);
const priceLabel = (m: ModelSpec) => (m.pricing ? `$${m.pricing.input}/$${m.pricing.output} per 1M` : 'price unknown');
// Settings go to the workspace when one is open, so each repo can target its own project.
const target = () => (vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);

function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /credential|invalid_grant|Could not load the default/i.test(msg)
    ? `${msg} — run "gcloud auth application-default login" and retry.`
    : msg;
}

class VertexProvider implements vscode.LanguageModelChatProvider {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  constructor(private costs: CostTracker) {}
  refresh() { this.changed.fire(); }

  provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): vscode.LanguageModelChatInformation[] {
    if (!PROJECT_ID.test(cfg().get<string>('projectId', ''))) {
      if (!options.silent) void vscode.commands.executeCommand('vertexCopilot.selectProject');
      return [];
    }
    return catalog().map(m => ({
      id: m.id, name: m.name, family: m.publisher === 'anthropic' ? 'claude' : 'gemini', version: m.id,
      maxInputTokens: m.maxInput, maxOutputTokens: m.maxOutput,
      detail: `Vertex · ${priceLabel(m)}`,
      tooltip: `${m.id} via Vertex AI (${cfg().get('projectId')}, ${cfg().get('location')})`,
      capabilities: { toolCalling: true, imageInput: false },
    }));
  }

  async provideLanguageModelChatResponse(info: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken) {
    const model = catalog().find(m => m.id === info.id);
    if (!model || !isAllowedModel(model.publisher, model.id)) throw new Error(`Model ${info.id} is not allowlisted.`);
    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try {
      const usage = await streamerFor(model)({
        ctx: vertexCtx(), model, messages, tools: options.tools ?? [], toolMode: options.toolMode,
        progress, signal: ac.signal, maxTokens: Math.min(model.maxOutput, 64_000),
      });
      log.info(`${model.id} ok in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`);
      await this.costs.record(model, usage);
    } catch (err) {
      if (token.isCancellationRequested) return;
      log.error(`${model.id} failed: ${explain(err)}`);
      throw new Error(explain(err));
    } finally { sub.dispose(); }
  }

  // shortcut: ~4 chars/token estimate, swap for the countTokens endpoints if budgeting needs precision.
  async provideTokenCount(_m: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    return Math.ceil((typeof text === 'string' ? text : JSON.stringify(text.content)).length / 4);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const costs = new CostTracker(context.globalState, () => cfg().get<string>('projectId', ''));
  const provider = new VertexProvider(costs);
  const update = async (key: string, value: unknown) => { await cfg().update(key, value, target()); provider.refresh(); };

  context.subscriptions.push(
    log, costs.status,
    vscode.lm.registerLanguageModelChatProvider('vertex-copilot', provider),
    vscode.window.registerTreeDataProvider('vertexCopilot.costs', costs),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vertexCopilot')) provider.refresh(); }),

    vscode.commands.registerCommand('vertexCopilot.selectProject', async () => {
      let items: vscode.QuickPickItem[] = [];
      try { items = (await searchProjects()).map(p => ({ label: p.id, description: p.name })); }
      catch (err) { log.warn(`project listing failed: ${explain(err)}`); }
      const manual = '$(edit) Enter project ID…';
      const pick = await vscode.window.showQuickPick([...items, { label: manual }], { title: 'Vertex AI project for Copilot', placeHolder: items.length ? 'Pick a project' : 'Could not list projects (check gcloud ADC); enter one manually' });
      if (!pick) return;
      const id = pick.label === manual
        ? await vscode.window.showInputBox({ prompt: 'GCP project ID', validateInput: v => (PROJECT_ID.test(v) ? undefined : 'Not a valid project ID') })
        : pick.label;
      if (id) { await update('projectId', id); vscode.window.showInformationMessage(`Vertex Copilot now uses project ${id}.`); }
    }),

    vscode.commands.registerCommand('vertexCopilot.selectLocation', async () => {
      const pick = await vscode.window.showQuickPick(['global', 'us-east5', 'us-central1', 'europe-west1', 'europe-west4', 'asia-southeast1', 'Other…'], { title: 'Vertex AI location' });
      const loc = pick === 'Other…' ? await vscode.window.showInputBox({ prompt: 'Vertex region, e.g. us-east5', validateInput: v => (LOCATION.test(v) ? undefined : 'Invalid region') }) : pick;
      if (loc) await update('location', loc);
    }),

    vscode.commands.registerCommand('vertexCopilot.checkAvailability', async () => {
      const all = catalog();
      const picks = await vscode.window.showQuickPick(all.map(m => ({ label: m.id, description: m.name, picked: true, m })), { canPickMany: true, title: 'Ping models (sends a tiny real request, a fraction of a cent each)' });
      if (!picks?.length) return;
      log.show(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Vertex models', cancellable: true }, async (prog, token) => {
        const ctx = vertexCtx();
        let ok = 0;
        for (const { m } of picks) {
          if (token.isCancellationRequested) break;
          if (!isAllowedModel(m.publisher, m.id)) continue; // never ping anything off the allowlist
          prog.report({ message: m.id });
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            const usage = await streamerFor(m)({ ctx, model: m, messages: [vscode.LanguageModelChatMessage.User('Reply with: ok')], tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto, progress: { report() {} }, signal: ac.signal, maxTokens: 16 });
            await costs.record(m, usage);
            log.info(`✓ ${m.id} available in ${ctx.project}/${ctx.location}`);
            ok++;
          } catch (err) { log.warn(`✗ ${m.id}: ${explain(err)}`); }
          finally { sub.dispose(); }
        }
        vscode.window.showInformationMessage(`Vertex: ${ok}/${picks.length} models available in ${ctx.project}. Details in the "Vertex Copilot" output.`);
      });
    }),

    vscode.commands.registerCommand('vertexCopilot.discoverModels', async () => {
      const { project } = vertexCtx();
      let ids: string[];
      try { ids = [...await listPublisherModels('anthropic', project), ...await listPublisherModels('google', project)]; }
      catch (err) { vscode.window.showErrorMessage(`Model discovery failed: ${explain(err)}`); return; }
      const known = new Set(catalog().map(m => m.id));
      const fresh = [...new Set(ids)].filter(id => !known.has(id)).sort();
      if (!fresh.length) { vscode.window.showInformationMessage('No new Claude/Gemini models found in the Vertex catalog.'); return; }
      const picks = await vscode.window.showQuickPick(fresh, { canPickMany: true, title: 'Add Claude/Gemini models to Copilot (prices unknown until you set them in settings)' });
      if (!picks?.length) return;
      const extra = cfg().get<ExtraModelSetting[]>('extraModels', []);
      await update('extraModels', [...extra, ...picks.map(id => ({ id }))]);
    }),

    vscode.commands.registerCommand('vertexCopilot.resetCosts', async () => {
      if ((await vscode.window.showWarningMessage('Erase all recorded Vertex cost history?', { modal: true }, 'Erase')) === 'Erase') await costs.reset();
    }),
  );
}

export function deactivate() {}
