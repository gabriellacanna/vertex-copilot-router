import * as vscode from 'vscode';
import { GoogleAuth, Impersonated, JWT } from 'google-auth-library';
import { readFileSync, statSync } from 'node:fs';
import { guardedFetch, isAllowedModel, LOCATION, PROJECT_ID, type Publisher } from './guard.ts';
import { buildCatalog, type ExtraModelSetting, type ModelSpec, type Usage } from './catalog.ts';

export interface VertexCtx { project: string; location: string; host: string; auth: GoogleAuth }

export const cfg = () => vscode.workspace.getConfiguration('vertexCopilot');
// Models found in the Vertex catalog at runtime; user extraModels override them.
let discovered: { at: number; ids: string[] } = { at: 0, ids: [] };
const pretty = (id: string) => id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
export const catalog = (): ModelSpec[] =>
  buildCatalog([...discovered.ids.map(id => ({ id, name: pretty(id) })), ...cfg().get<ExtraModelSetting[]>('extraModels', [])]);

/** Re-reads the Claude/Gemini catalog if older than maxAgeMs. Returns the newly found IDs. */
export async function refreshDiscovered(project: string, maxAgeMs = 6 * 3600_000): Promise<string[]> {
  if (Date.now() - discovered.at < maxAgeMs) return [];
  const before = new Set(catalog().map(m => m.id));
  const ids = [...new Set([...await listPublisherModels('anthropic', project), ...await listPublisherModels('google', project)])];
  discovered = { at: Date.now(), ids };
  return ids.filter(id => !before.has(id));
}

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
export const SA_EMAIL = /^([a-z][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,29}\.iam\.gserviceaccount\.com|\d+-compute@developer\.gserviceaccount\.com)$/;
export type AuthMode = 'adc' | 'impersonate' | 'keyFile';

// Credentials come from Google's own chain (gcloud ADC, impersonation, or a key file the user picks).
// The extension never stores, prompts for, or logs a secret. Auth settings are application-scoped,
// so a workspace's .vscode/settings.json can't switch identities.
let cached: { key: string; auth: Promise<GoogleAuth> } | undefined;
export function getAuth(): Promise<GoogleAuth> {
  const mode = cfg().get<AuthMode>('auth.mode', 'adc');
  const sa = cfg().get<string>('auth.serviceAccount', '').trim();
  const keyFile = cfg().get<string>('auth.keyFile', '').trim();
  const key = `${mode}|${sa}|${keyFile}`;
  if (cached?.key === key) return cached.auth;
  const auth = buildAuth(mode, sa, keyFile);
  auth.catch(() => { if (cached?.key === key) cached = undefined; }); // retry after a fix
  cached = { key, auth };
  return auth;
}

async function buildAuth(mode: AuthMode, sa: string, keyFile: string): Promise<GoogleAuth> {
  if (mode === 'impersonate') {
    if (!SA_EMAIL.test(sa)) throw new Error('Set a valid service account email in "vertexCopilot.auth.serviceAccount".');
    // Short-lived tokens minted from the user's ADC; no key ever touches disk.
    const sourceClient = await new GoogleAuth({ scopes: SCOPES }).getClient();
    return new GoogleAuth({ authClient: new Impersonated({ sourceClient, targetPrincipal: sa, targetScopes: SCOPES, lifetime: 3600 }) });
  }
  if (mode === 'keyFile') {
    let st;
    try { st = statSync(keyFile); } catch { throw new Error(`Service account key file not found: "${keyFile}".`); }
    if (!st.isFile()) throw new Error(`"${keyFile}" is not a file.`);
    if (process.platform !== 'win32' && st.mode & 0o077) throw new Error(`Key file "${keyFile}" is readable by other users; run: chmod 600 "${keyFile}"`);
    // Only plain service-account keys: external_account / other configs can carry attacker-chosen URLs.
    let k: any;
    try { k = JSON.parse(readFileSync(keyFile, 'utf8')); } catch { throw new Error(`"${keyFile}" is not valid JSON.`); }
    if (k?.type !== 'service_account' || !SA_EMAIL.test(k.client_email ?? '') || typeof k.private_key !== 'string')
      throw new Error(`"${keyFile}" is not a Google service account key.`);
    if (k.token_uri && k.token_uri !== 'https://oauth2.googleapis.com/token') throw new Error(`Refusing key file with unexpected token_uri.`);
    return new GoogleAuth({ authClient: new JWT({ email: k.client_email, key: k.private_key, keyId: k.private_key_id, scopes: SCOPES }) });
  }
  return new GoogleAuth({ scopes: SCOPES });
}

export async function vertexCtx(): Promise<VertexCtx> {
  const project = cfg().get<string>('projectId', '').trim();
  const location = cfg().get<string>('location', 'global').trim();
  if (!PROJECT_ID.test(project)) throw new Error('No valid GCP project selected. Run "Vertex Copilot: Select GCP Project".');
  if (!LOCATION.test(location)) throw new Error(`Invalid Vertex location "${location}".`);
  return { project, location, host: location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`, auth: await getAuth() };
}

export async function authHeaders(quotaProject?: string, auth?: GoogleAuth): Promise<Headers> {
  const h = new Headers(await (auth ?? await getAuth()).getRequestHeaders());
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

// Catalog entries that aren't text chat models (or need allowlisting by Google) are skipped.
const isChatModel = (id: string) => !/embedding|image|tts|live|audio|robotics|cyber|customtools|native|computer-use|-exp/.test(id);

/** Lists model IDs in Vertex's catalog for google/anthropic only. Listing is not inference. */
export async function listPublisherModels(publisher: Publisher, quotaProject: string): Promise<string[]> {
  const ids: string[] = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const d = await getJson(`https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, quotaProject);
    for (const m of d.publisherModels ?? []) {
      const id = String(m.name ?? '').split('/').pop()!;
      if (isAllowedModel(publisher, id) && isChatModel(id) && (!m.launchStage || /^(GA|PUBLIC_PREVIEW)$/.test(m.launchStage))) ids.push(id);
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
