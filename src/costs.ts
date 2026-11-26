import * as vscode from 'vscode';
import { costOf, type ModelSpec, type Usage } from './catalog.ts';

interface Bucket { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unpriced: number }
type ByModel = Record<string, Bucket>;
const KEY = 'vertexCopilot.costs.v1';
const LOG_KEY = 'vertexCopilot.requests.v1';
const LOG_MAX = 20_000; // ~2 MB of globalState; oldest entries roll off

export type Source = 'picker' | '@vertex' | 'ping';
/** One request, kept for the dashboard. Short keys keep globalState small. */
export interface Entry { t: number; s: string; p: string; m: string; src: Source; i: number; o: number; cr: number; cw: number; c: number | null }
const empty = (): Bucket => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const sum = (b: ByModel) => Object.values(b).reduce((a, x) => { for (const f of Object.keys(a) as (keyof Bucket)[]) a[f] += x[f]; return a; }, empty());

function add(b: ByModel, model: string, u: Usage, cost: number | undefined) {
  const x = (b[model] ??= empty());
  x.requests++; x.input += u.input; x.output += u.output; x.cacheRead += u.cacheRead; x.cacheWrite += u.cacheWrite;
  if (cost === undefined) x.unpriced++; else x.cost += cost;
}

type Node = { label: string; description?: string; tooltip?: string; children?: Node[]; icon?: string; command?: string };

export class CostTracker implements vscode.TreeDataProvider<Node> {
  private session: ByModel = {};
  private last?: string;
  private warned = false;
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private recorded = new vscode.EventEmitter<void>();
  readonly onDidRecord = this.recorded.event;

  constructor(private state: vscode.Memento, private project: () => string) {
    this.status.command = 'vertexCopilot.openDashboard';
    this.render();
    this.status.show();
  }

  private all(): Record<string, ByModel> { return this.state.get(KEY, {}); }

  history(): Entry[] { return this.state.get<Entry[]>(LOG_KEY, []); }

  async record(model: ModelSpec, u: Usage, src: Source) {
    const cost = costOf(model.pricing, u);
    const project = this.project() || '(none)';
    add(this.session, model.id, u, cost);
    const all = this.all();
    add((all[project] ??= {}), model.id, u, cost);
    const log = this.history();
    log.push({ t: Date.now(), s: vscode.env.sessionId, p: project, m: model.id, src, i: u.input, o: u.output, cr: u.cacheRead, cw: u.cacheWrite, c: cost ?? null });
    await Promise.all([this.state.update(KEY, all), this.state.update(LOG_KEY, log.slice(-LOG_MAX))]);
    this.recorded.fire();
    this.last = `${model.name}: ${k(u.input + u.cacheRead + u.cacheWrite)} in / ${k(u.output)} out · ${cost === undefined ? 'price unknown' : usd(cost)}`;
    this.render();
    const budget = vscode.workspace.getConfiguration('vertexCopilot').get<number>('budgetUsd', 0);
    const spent = sum(all[project]).cost;
    if (budget > 0 && spent >= budget && !this.warned) {
      this.warned = true;
      vscode.window.showWarningMessage(`Vertex spend on ${project} reached ${usd(spent)} (budget ${usd(budget)}).`);
    }
  }

  async reset() { this.session = {}; this.last = undefined; this.warned = false; await Promise.all([this.state.update(KEY, {}), this.state.update(LOG_KEY, [])]); this.render(); this.recorded.fire(); }

  /** All-time spend on the current project for one model. */
  spent(model: string): Bucket { return this.all()[this.project() || '(none)']?.[model] ?? empty(); }

  render() {
    const s = sum(this.session);
    this.status.text = `$(cloud) ${this.project() || 'no project'} · ${usd(s.cost)}`;
    this.status.tooltip = `Vertex spend this session (${s.requests} requests, project ${this.project() || 'not set'}). Click for details.`;
    this.changed.fire();
  }

  private models(b: ByModel): Node[] {
    return Object.entries(b).sort((x, y) => y[1].cost - x[1].cost).map(([id, x]) => ({
      label: id,
      description: `${usd(x.cost)}${x.unpriced ? ` (+${x.unpriced} unpriced)` : ''} · ${x.requests} req`,
      tooltip: `input ${k(x.input)} · output ${k(x.output)} · cache read ${k(x.cacheRead)} · cache write ${k(x.cacheWrite)}`,
      icon: id.startsWith('claude') ? 'sparkle' : 'star-full',
    }));
  }

  getChildren(n?: Node): Node[] {
    if (n) return n.children ?? [];
    const all = this.all();
    const s = sum(this.session);
    const nodes: Node[] = [
      { label: 'Open cost dashboard', icon: 'graph', command: 'vertexCopilot.openDashboard' },
      { label: 'Project', description: `${this.project() || 'not set'} · ${vscode.workspace.getConfiguration('vertexCopilot').get('location')}`, icon: 'project' },
      { label: 'This session', description: `${usd(s.cost)} · ${s.requests} req`, children: this.models(this.session), icon: 'pulse' },
      ...Object.entries(all).map(([p, b]) => ({ label: `All time · ${p}`, description: usd(sum(b).cost), children: this.models(b), icon: 'history' })),
    ];
    if (this.last) nodes.push({ label: 'Last request', description: this.last, icon: 'clock' });
    return nodes;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const t = new vscode.TreeItem(n.label, n.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    t.description = n.description;
    t.tooltip = n.tooltip ?? n.description;
    if (n.icon) t.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.command) t.command = { command: n.command, title: n.label };
    return t;
  }
}
