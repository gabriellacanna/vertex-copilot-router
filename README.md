# Vertex Router for GitHub Copilot

Use **Claude** and **Gemini** from *your own* Google Cloud Vertex AI project directly in GitHub Copilot Chat (ask, edit and agent mode), billed to the project you pick, with live cost tracking inside VS Code.

## The one rule: only Anthropic and Google models

The extension can never call, ping, or list any other model vendor. Every outbound request goes through one function, [`src/guard.ts`](src/guard.ts), which rejects a request before it is sent unless it is:

| Allowed | Pattern |
|---|---|
| Claude inference | `{region-}aiplatform.googleapis.com/v1/projects/{p}/locations/{l}/publishers/anthropic/models/claude-*:(stream)RawPredict` |
| Gemini inference | `.../publishers/google/models/gemini-*:(stream)GenerateContent` |
| Catalog listing (no inference) | `aiplatform.googleapis.com/v1beta1/publishers/(google\|anthropic)/models` |
| Project picker | `cloudresourcemanager.googleapis.com/v3/projects:search` |

Everything else is blocked: other publishers (Qwen, DeepSeek, Kimi/Moonshot, GLM/Zhipu, MiniMax, Llama, Mistral…), the Vertex OpenAI-compatible MaaS gateway, custom endpoints, Gemma, other hosts, plain http, redirects. A deny-list of Chinese model names is applied on top of the allowlist as a second layer. Model IDs you add in settings go through the same check, so they cannot widen it. See [`test/guard.test.mts`](test/guard.test.mts).

## Setup

1. Have VS Code 1.104 or newer with GitHub Copilot Chat signed in.
2. Authenticate to Google Cloud (pick one with **Vertex Copilot: Select Authentication**):
   - **Automatic (default)**: uses Application Default Credentials if you've set them up, otherwise the account you're signed into with `gcloud auth login`. Nothing to configure.
   - **Impersonate a service account (recommended for service accounts)**: your ADC user mints short-lived tokens for the service account, so no key file exists. Your user needs `roles/iam.serviceAccountTokenCreator` on the service account.
   - **Service account key file**: a JSON key on disk. It must be `chmod 600`, and only plain `service_account` keys with Google's own token URI are accepted.

   Whichever identity you use needs `roles/aiplatform.user` on the project. Auth settings are user-level only, so a workspace can't switch your identity.
3. Enable Claude models in Vertex AI Model Garden for your project (Gemini is on by default).
4. Install **Vertex Router for GitHub Copilot** (`lacanna.vertex-copilot-router`) from the VS Code Marketplace, or the `.vsix` from [Releases](https://github.com/gabriellacanna/vertex-copilot-router/releases) via **Extensions → … → Install from VSIX**.
5. The project is picked up automatically from `gcloud config get-value project` (or `GOOGLE_CLOUD_PROJECT`); set `vertexCopilot.projectId` only to override it.
6. In Copilot Chat open the model picker → *Manage Models…* → **Vertex Models**, tick the models you want once, then choose one. Each model shows what you've spent on it on this project, e.g. `$0.42 spent · $4/$20 per 1M`.

## Features

- **`@vertex` in Copilot Chat** (works even when BYOK models are blocked by policy): type `@vertex` in a **Local** chat session to talk to Claude/Gemini on your project directly. It keeps the conversation, reads `#file`/selection references, can use Copilot's agent tools (file edits, terminal, search; Copilot asks you to confirm as usual), and ends each answer with tokens and cost. `/model` switches the model (default Claude Opus 5.5).

- **Copilot model provider** with streaming, tool calling (agent mode), Claude prompt caching, and replay of Claude thinking blocks and Gemini thought signatures between tool calls.
- **Cost dashboard**: click the status bar item (or the graph icon in the *Vertex Copilot → Costs* view) to open it. It has:
  - spend, requests, tokens, cache hit rate and budget tiles;
  - filters for this session, today, 7 days, 30 days or all time, and per project;
  - a stacked spend-over-time chart by model, and breakdowns by model and by source (picker, `@vertex`, pings);
  - a sessions table (one per VS Code window; click a row to drill in) and a table of recent requests;
  - CSV export. It follows your VS Code theme.
- **Check Model Availability**: pings the allowlisted models you choose with a tiny request (a fraction of a cent, also counted in costs).
- **Always-current model list**: every 6 hours (and on **Refresh Model List**) the extension reads the Vertex catalog for the two allowed publishers and adds new Claude/Gemini chat models to the picker automatically. Built-in prices cover the current lineup; newly discovered models show "price unknown" until you set prices in `vertexCopilot.extraModels`.
- **Select Vertex Location**: `global` (default) or a region such as `us-east5`.

## Settings

| Setting | Default | |
|---|---|---|
| `vertexCopilot.auth.mode` | `auto` | `auto`, `gcloud`, `adc`, `impersonate` or `keyFile` (user settings only) |
| `vertexCopilot.auth.serviceAccount` | `""` | Service account email for `impersonate` |
| `vertexCopilot.auth.keyFile` | `""` | Path to a service account JSON key for `keyFile` |
| `vertexCopilot.projectId` | `""` | Override the gcloud default project |
| `vertexCopilot.location` | `global` | Vertex location |
| `vertexCopilot.budgetUsd` | `0` | Warn when all-time spend for the project reaches this (0 = off) |
| `vertexCopilot.extraModels` | `[]` | `{ id, name?, inputPer1M?, outputPer1M?, cacheReadPer1M?, maxInputTokens?, maxOutputTokens? }`; only `claude-*` / `gemini-*` IDs |

Built-in models (Claude Opus/Sonnet/Haiku 5.5, Fable 5.1; Gemini 4 Argon/Carbon/Hydrogen, 3.8 Flash, 3.1 Pro preview, 3.5 Flash-Lite) and prices were checked against the docs on 2026-11-26; Gemini 4 Carbon/Hydrogen prices weren't published yet, so they show "price unknown". They are estimates; your Cloud Billing report is the source of truth. Override them through `extraModels` with the same `id`.

## Security

- **No secrets handled by the extension**: credentials come from Google's own auth chain (ADC, impersonation, or a key file you choose). Nothing is stored, prompted for, or logged. Logs contain only model ID and token counts, never prompts or tokens.
- **Untrusted workspaces**: `projectId`, `location` and `extraModels` from workspace settings are ignored until you trust the folder, so a cloned repo can't redirect your prompts or credentials to someone else's project.
- **Input validation**: project IDs, locations and model IDs are regex-validated before they reach a URL; redirects are refused (`redirect: "error"`); the Anthropic SDK base URL is pinned so `ANTHROPIC_VERTEX_BASE_URL` can't reroute traffic.
- **Dependencies**: four runtime packages (`@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk`, `google-auth-library`, and their transitive deps), all latest at release time, `npm audit` clean (a vulnerable `minimatch` in the `vsce` build tool is overridden to 11.0.9). CI fails on any advisory; Dependabot runs weekly.
- **No webviews**: UI is native (tree view, status bar, quick picks), so there is no HTML surface to inject into.

Report vulnerabilities privately via GitHub Security Advisories on this repository.

## Build

```bash
npm ci
npm run package
```

## Limits

- Image input isn't enabled yet.
- Token counts shown to Copilot before a request are estimates (~4 chars/token); costs come from the actual usage Vertex returns.
- Multi-region endpoints (`us`, `eu`) aren't supported, only `global` and single regions.
- Neither the model picker nor `@vertex` works in Copilot **cloud/remote** sessions: those run on GitHub's servers, where VS Code extensions don't run. Use a Local session.
- Using third-party models in Copilot's picker needs a Copilot plan that allows bring-your-own models; on Business/Enterprise plans your admin may have to enable it.
