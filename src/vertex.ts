import * as vscode from 'vscode';
import { GoogleAuth } from 'google-auth-library';
import { guardedFetch, isAllowedModel, LOCATION, PROJECT_ID, type Publisher } from './guard.ts';
import { buildCatalog, type ExtraModelSetting, type ModelSpec, type Usage } from './catalog.ts';

// Application Default Credentials only: the extension never stores or asks for secrets.
export const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface VertexCtx { project: string; location: string; host: string; auth: GoogleAuth }

export const cfg = () => vscode.workspace.getConfiguration('vertexCopilot');
export const catalog = (): ModelSpec[] => buildCatalog(cfg().get<ExtraModelSetting[]>('extraModels', []));

export function vertexCtx(): VertexCtx {
  const project = cfg().get<string>('projectId', '').trim();
  const location = cfg().get<string>('location', 'global').trim();
  if (!PROJECT_ID.test(project)) throw new Error('No valid GCP project selected. Run "Vertex Copilot: Select GCP Project".');
  if (!LOCATION.test(location)) throw new Error(`Invalid Vertex location "${location}".`);
  return { project, location, host: location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`, auth };
}

export async function authHeaders(quotaProject?: string): Promise<Headers> {
  const h = new Headers(await auth.getRequestHeaders());
  h.set('content-type', 'application/json');
  if (quotaProject) h.set('x-goog-user-project', quotaProject);
  return h;
}

export async function getJson(url: string, quotaProject?: string): Promise<any> {
  const res = await guardedFetch(url, { headers: await authHeaders(quotaProject) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function searchProjects(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const d = await getJson(`https://cloudresourcemanager.googleapis.com/v3/projects:search${page ? `?pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const p of d.projects ?? []) if (p.state === 'ACTIVE' && PROJECT_ID.test(p.projectId)) out.push({ id: p.projectId, name: p.displayName ?? p.projectId });
    if (!(page = d.nextPageToken)) break;
  }
  return out;
}

/** Lists model IDs in Vertex's catalog for google/anthropic only. Listing is not inference. */
export async function listPublisherModels(publisher: Publisher, quotaProject: string): Promise<string[]> {
  const ids: string[] = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const d = await getJson(`https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, quotaProject);
    for (const m of d.publisherModels ?? []) {
      const id = String(m.name ?? '').split('/').pop()!;
      if (isAllowedModel(publisher, id)) ids.push(id);
    }
    if (!(page = d.nextPageToken)) break;
  }
  return ids;
}

export interface StreamArgs {
  ctx: VertexCtx;
  model: ModelSpec;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools: readonly vscode.LanguageModelChatTool[];
  toolMode: vscode.LanguageModelChatToolMode;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  signal: AbortSignal;
  maxTokens: number;
}
export type Streamer = (a: StreamArgs) => Promise<Usage>;

export const SYSTEM_ROLE = 3; // LanguageModelChatMessageRole.System (proposed API) — Copilot sends it

export const textOf = (parts: readonly unknown[]): string =>
  parts.map(p => (p instanceof vscode.LanguageModelTextPart ? p.value : typeof p === 'string' ? p : '')).join('');

/** Bounded memo so long sessions can't grow memory without limit. */
export class Memo<V> extends Map<string, V> {
  override set(k: string, v: V) {
    if (this.size >= 2000) this.delete(this.keys().next().value!);
    return super.set(k, v);
  }
}
