import * as vscode from 'vscode';
import { GoogleAuth, Impersonated, JWT } from 'google-auth-library';
import { readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
export type AuthMode = 'auto' | 'adc' | 'gcloud' | 'impersonate' | 'keyFile';

// Credentials come from Google's own chain (gcloud ADC, impersonation, or a key file the user picks).
// The extension never stores, prompts for, or logs a secret. Auth settings are application-scoped,
// so a workspace's .vscode/settings.json can't switch identities.
let cached: { key: string; auth: Promise<GoogleAuth> } | undefined;
export function getAuth(): Promise<GoogleAuth> {
  const mode = cfg().get<AuthMode>('auth.mode', 'auto');
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
  if (mode === 'gcloud') return gcloudAuth();
  const adc = new GoogleAuth({ scopes: SCOPES });
  if (mode === 'adc') return adc;
  // auto: ADC when it works, otherwise the session from `gcloud auth login`.
  try { await adc.getRequestHeaders(); return adc; }
  catch (adcErr) {
    try { const g = gcloudAuth(); await g.getRequestHeaders(); return g; }
    catch { throw new Error(`No usable Google credentials (${adcErr instanceof Error ? adcErr.message : adcErr}). Run "gcloud auth login" or "gcloud auth application-default login".`); }
  }
}

// Fixed argv, no shell: nothing from settings or the workspace reaches the command line.
const run = promisify(execFile);
const gcloud = async (...args: string[]) =>
  (await run(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud', args, { timeout: 20_000, windowsHide: true, shell: process.platform === 'win32' })).stdout.trim();

/** Uses the gcloud CLI's logged-in user. Tokens are cached in memory only, never logged. */
function gcloudAuth(): GoogleAuth {
  let token = '', exp = 0;
  const client = {
    projectId: undefined,
    async getRequestHeaders() {
      if (Date.now() > exp) { token = await gcloud('auth', 'print-access-token', '--quiet'); exp = Date.now() + 45 * 60_000; }
      return new Headers({ authorization: `Bearer ${token}` });
    },
  };
  return new GoogleAuth({ authClient: client as any });
}

let detected: { at: number; p: Promise<string> } | undefined;
/** Settings first, then GOOGLE_CLOUD_PROJECT, then `gcloud config get-value project`. */
export async function currentProject(): Promise<string> {
  const set = cfg().get<string>('projectId', '').trim();
  if (set) return set;
  if (!detected || Date.now() - detected.at > 60_000) detected = { at: Date.now(), p: (async () => {
    const env = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.CLOUDSDK_CORE_PROJECT ?? '';
    if (PROJECT_ID.test(env)) return env;
    try { const p = await gcloud('config', 'get-value', 'project', '--quiet'); if (PROJECT_ID.test(p)) return p; } catch { /* gcloud missing */ }
    return '';
  })() };
  return detected.p;
}

export async function vertexCtx(): Promise<VertexCtx> {
  const project = await currentProject();
  const location = cfg().get<string>('location', 'global').trim();
  if (!PROJECT_ID.test(project)) throw new Error('No GCP project found. Run "gcloud config set project <id>" or "Vertex Copilot: Select GCP Project".');
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

export const textOf = (parts: readonly unknown[]): string => parts.map(partText).join('');

// Tool results are often prompt-tsx JSON trees; pull the text leaves out rather than dropping them.
function partText(p: unknown): string {
  if (p instanceof vscode.LanguageModelTextPart) return p.value;
  if (typeof p === 'string') return p;
  const leaves: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 50 || v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) typeof x === 'string' && (k === 'text' || k === 'value') ? leaves.push(x) : walk(x, depth + 1);
  };
  walk((p as { value?: unknown })?.value ?? p, 0);
  return leaves.join('');
}

/** Bounded memo so long sessions can't grow memory without limit. */
export class Memo<V> extends Map<string, V> {
  override set(k: string, v: V) {
    if (this.size >= 2000) this.delete(this.keys().next().value!);
    return super.set(k, v);
  }
}

/** Error text with a hint for auth problems. */
export function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/credential|invalid_grant|Could not load the default|unauthenticated|PERMISSION_DENIED|iam\.serviceAccounts/i.test(msg)) return msg;
  const mode = cfg().get<string>('auth.mode', 'auto');
  return `${msg} — ${mode === 'impersonate'
    ? 'check that your ADC user has roles/iam.serviceAccountTokenCreator on the service account, and the account has roles/aiplatform.user'
    : mode === 'keyFile' ? 'check the key file and that its service account has roles/aiplatform.user'
    : 'run "gcloud auth login" (or "gcloud auth application-default login") and check you have roles/aiplatform.user'}. Change with "Vertex Copilot: Select Authentication".`;
}
