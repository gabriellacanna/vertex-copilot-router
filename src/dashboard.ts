import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { CostTracker, Entry } from './costs.ts';
import { catalog, cfg } from './vertex.ts';

// Cost dashboard. The webview only renders data posted to it: no network access, scripts and styles
// load solely from the extension's media folder under a strict CSP.
export class Dashboard {
  private panel?: vscode.WebviewPanel;
  constructor(private extUri: vscode.Uri, private costs: CostTracker, private project: () => string) {
    costs.onDidRecord(() => this.post());
  }

  open() {
    if (this.panel) { this.panel.reveal(); return; }
    const media = vscode.Uri.joinPath(this.extUri, 'media');
    const p = this.panel = vscode.window.createWebviewPanel('vertexCopilot.dashboard', 'Vertex Costs', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [media], enableCommandUris: false });
    p.iconPath = vscode.Uri.joinPath(media, 'activity.svg');
    const nonce = randomBytes(16).toString('base64');
    const src = (f: string) => p.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    p.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${p.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${p.webview.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${src('dashboard.css')}"><title>Vertex Costs</title></head>
<body><main id="app" aria-live="polite"></main><div id="tip" role="tooltip" hidden></div><script nonce="${nonce}" src="${src('dashboard.js')}"></script></body></html>`;
    p.webview.onDidReceiveMessage(m => this.onMessage(m));
    p.onDidDispose(() => (this.panel = undefined));
  }

  private post() {
    if (!this.panel) return;
    void this.panel.webview.postMessage({
      type: 'data',
      entries: this.costs.history(),
      session: vscode.env.sessionId,
      project: this.project(),
      location: cfg().get('location'),
      budget: cfg().get<number>('budgetUsd', 0),
      names: Object.fromEntries(catalog().map(m => [m.id, m.name])),
    });
  }

  private async onMessage(m: { type?: string }) {
    if (m?.type === 'ready') this.post();
    else if (m?.type === 'export') await this.exportCsv();
    else if (m?.type === 'reset') await vscode.commands.executeCommand('vertexCopilot.resetCosts');
  }

  private async exportCsv() {
    const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(`vertex-costs-${new Date().toISOString().slice(0, 10)}.csv`) });
    if (!uri) return;
    const rows = this.costs.history().map((e: Entry) => [new Date(e.t).toISOString(), e.s, e.p, e.m, e.src, e.i, e.o, e.cr, e.cw, e.c ?? ''].join(','));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(['time,session,project,model,source,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd', ...rows].join('\n') + '\n'));
    vscode.window.showInformationMessage(`Exported ${rows.length} requests to ${uri.fsPath}`);
  }
}
