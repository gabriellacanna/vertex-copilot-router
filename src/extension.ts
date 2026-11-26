import * as vscode from 'vscode';
import { isAllowedModel, LOCATION, PROJECT_ID } from './guard.ts';
import type { ModelSpec } from './catalog.ts';
import { catalog, cfg, currentProject, explain, refreshDiscovered, SA_EMAIL, searchProjects, vertexCtx, type Streamer } from './vertex.ts';
import { streamClaude } from './claude.ts';
import { streamGemini } from './gemini.ts';
import { CostTracker } from './costs.ts';
import { createVertexParticipant } from './participant.ts';
import { Dashboard } from './dashboard.ts';

const log = vscode.window.createOutputChannel('Vertex Copilot', { log: true });
const streamerFor = (m: ModelSpec): Streamer => (m.publisher === 'anthropic' ? streamClaude : streamGemini);
const priceLabel = (m: ModelSpec) => (m.pricing ? `$${m.pricing.input}/$${m.pricing.output} per 1M` : 'price unknown');
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
let project = ''; // last resolved project, shown in the UI and used to bucket costs
let prompted = false;
// Settings go to the workspace when one is open, so each repo can target its own project.
const target = () => (vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);


class VertexProvider implements vscode.LanguageModelChatProvider {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  constructor(private costs: CostTracker) {}
  refresh() { this.changed.fire(); }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<vscode.LanguageModelChatInformation[]> {
    project = await currentProject();
    this.costs.render();
    if (!PROJECT_ID.test(project)) {
      if (!options.silent && !prompted) {
        prompted = true;
        void vscode.window.showInformationMessage('Vertex Models: no Google Cloud project found. Set one with "gcloud config set project <id>" or pick one now.', 'Select Project')
          .then(a => a && vscode.commands.executeCommand('vertexCopilot.selectProject'));
      }
      return [];
    }
    // Background refresh so the picker never waits on the network; fires a change when new models appear.
    refreshDiscovered(project).then(n => { if (n.length) { log.info(`discovered ${n.join(', ')}`); this.refresh(); } },
      err => log.warn(`model discovery failed: ${explain(err)}`));
    return catalog().map(m => {
      const s = this.costs.spent(m.id);
      return {
        id: m.id, name: m.name, family: m.publisher === 'anthropic' ? 'claude' : 'gemini', version: m.id,
        maxInputTokens: m.maxInput, maxOutputTokens: m.maxOutput,
        // Spend is shown right in the model picker and refreshed after every request.
        detail: `${usd(s.cost)} spent · ${priceLabel(m)}`,
        tooltip: `${m.id} on Vertex AI\nProject: ${project} (${cfg().get('location')})\nSpent on this project: ${usd(s.cost)} over ${s.requests} requests${s.unpriced ? ` (+${s.unpriced} unpriced)` : ''}\nPrice: ${priceLabel(m)}`,
        capabilities: { toolCalling: true, imageInput: false },
      };
    });
  }

  async provideLanguageModelChatResponse(info: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken) {
    const model = catalog().find(m => m.id === info.id);
    if (!model || !isAllowedModel(model.publisher, model.id)) throw new Error(`Model ${info.id} is not allowlisted.`);
    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try {
      const usage = await streamerFor(model)({
        ctx: await vertexCtx(), model, messages, tools: options.tools ?? [], toolMode: options.toolMode,
        progress, signal: ac.signal, maxTokens: Math.min(model.maxOutput, 64_000),
      });
      log.info(`${model.id} ok in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`);
      await this.costs.record(model, usage, 'picker');
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
  const costs = new CostTracker(context.globalState, () => project);
  const provider = new VertexProvider(costs);
  costs.onDidRecord(() => provider.refresh());
  const dashboard = new Dashboard(context.extensionUri, costs, () => project);
  void currentProject().then(p => { project = p; costs.render(); log.info(p ? `using project ${p}` : 'no GCP project detected'); });
  const update = async (key: string, value: unknown) => { await cfg().update(key, value, target()); provider.refresh(); };

  context.subscriptions.push(
    log, costs.status,
    vscode.lm.registerLanguageModelChatProvider('vertex-copilot', provider),
    vscode.window.registerTreeDataProvider('vertexCopilot.costs', costs),
    createVertexParticipant(costs, streamerFor),
    vscode.commands.registerCommand('vertexCopilot.openDashboard', () => dashboard.open()),

    vscode.commands.registerCommand('vertexCopilot.selectParticipantModel', async () => {
      const current = cfg().get<string>('participant.model');
      const pick = await vscode.window.showQuickPick(catalog().map(m => ({ label: m.id, description: m.name + (m.id === current ? ' (current)' : ''), detail: priceLabel(m) })), { title: 'Model for @vertex' });
      if (pick) await cfg().update('participant.model', pick.label, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vertexCopilot')) provider.refresh(); }),
    // Watch for project switches made with `gcloud config set project` while VS Code is open.
    vscode.window.onDidChangeWindowState(w => { if (w.focused) void currentProject().then(p => { if (p !== project) provider.refresh(); }); }),

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

    vscode.commands.registerCommand('vertexCopilot.selectAuth', async () => {
      const G = vscode.ConfigurationTarget.Global; // auth settings are user-level only
      const pick = await vscode.window.showQuickPick([
        { label: 'Automatic (recommended)', description: 'ADC if set up, otherwise your `gcloud auth login` session', mode: 'auto' as const },
        { label: 'gcloud CLI user', description: 'the account from `gcloud auth login`', mode: 'gcloud' as const },
        { label: 'Application Default Credentials', description: 'gcloud auth application-default login', mode: 'adc' as const },
        { label: 'Impersonate a service account', description: 'recommended for service accounts: no key file, needs roles/iam.serviceAccountTokenCreator', mode: 'impersonate' as const },
        { label: 'Service account key file', description: 'JSON key on disk (chmod 600)', mode: 'keyFile' as const },
      ], { title: 'How should Vertex Copilot authenticate to Google Cloud?' });
      if (!pick) return;
      if (pick.mode === 'impersonate') {
        const sa = await vscode.window.showInputBox({ prompt: 'Service account email', value: cfg().get('auth.serviceAccount'), validateInput: v => (SA_EMAIL.test(v.trim()) ? undefined : 'Not a service account email') });
        if (!sa) return;
        await cfg().update('auth.serviceAccount', sa.trim(), G);
      } else if (pick.mode === 'keyFile') {
        const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Service account key': ['json'] }, title: 'Select service account key' });
        if (!file?.[0]) return;
        await cfg().update('auth.keyFile', file[0].fsPath, G);
      }
      await cfg().update('auth.mode', pick.mode, G);
      provider.refresh();
      vscode.window.showInformationMessage(`Vertex Copilot auth: ${pick.label}.`);
    }),

    vscode.commands.registerCommand('vertexCopilot.checkAvailability', async () => {
      const all = catalog();
      const picks = await vscode.window.showQuickPick(all.map(m => ({ label: m.id, description: m.name, picked: true, m })), { canPickMany: true, title: 'Ping models (sends a tiny real request, a fraction of a cent each)' });
      if (!picks?.length) return;
      log.show(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Vertex models', cancellable: true }, async (prog, token) => {
        const ctx = await vertexCtx();
        let ok = 0;
        for (const { m } of picks) {
          if (token.isCancellationRequested) break;
          if (!isAllowedModel(m.publisher, m.id)) continue; // never ping anything off the allowlist
          prog.report({ message: m.id });
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            const usage = await streamerFor(m)({ ctx, model: m, messages: [vscode.LanguageModelChatMessage.User('Reply with: ok')], tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto, progress: { report() {} }, signal: ac.signal, maxTokens: 16 });
            await costs.record(m, usage, 'ping');
            log.info(`✓ ${m.id} available in ${ctx.project}/${ctx.location}`);
            ok++;
          } catch (err) { log.warn(`✗ ${m.id}: ${explain(err)}`); }
          finally { sub.dispose(); }
        }
        vscode.window.showInformationMessage(`Vertex: ${ok}/${picks.length} models available in ${ctx.project}. Details in the "Vertex Copilot" output.`);
      });
    }),

    vscode.commands.registerCommand('vertexCopilot.refreshModels', async () => {
      const { project } = await vertexCtx();
      try {
        const fresh = await refreshDiscovered(project, 0);
        provider.refresh();
        vscode.window.showInformationMessage(fresh.length ? `New models: ${fresh.join(', ')}` : 'Model list is up to date.');
      } catch (err) { vscode.window.showErrorMessage(`Model refresh failed: ${explain(err)}`); }
    }),

    vscode.commands.registerCommand('vertexCopilot.resetCosts', async () => {
      if ((await vscode.window.showWarningMessage('Erase all recorded Vertex cost history?', { modal: true }, 'Erase')) === 'Erase') await costs.reset();
    }),
  );
}

export function deactivate() {}
