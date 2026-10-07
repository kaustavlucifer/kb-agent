# Calling Claude via the Salesforce Internal AI Model Gateway

Reference for calling Claude (and other models) through Salesforce's internal LLM gateway, as used by KB Agent. Facts are marked **verified** (tested live against the gateway on 2026-10-05) or **reported** (from internal Slack discussions; treat as current guidance, not a contract).

> Never commit, log, or paste gateway keys. Keep them in environment variables or extension storage only.

## 1. The gateway

| Item | Value |
|---|---|
| Base URL | `https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl` |
| Implementation | LiteLLM proxy (response headers show `x-litellm-version`, e.g. `1.100.0`) — **verified** |
| Backends | Anthropic models are routed to Bedrock or Vertex; the backend actually used is reported in `x-litellm-model-name` (e.g. `bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0`) — **verified** |
| Docs | `git.soma.salesforce.com/codeai/codegenie-docs/blob/main/docs/ai/express-llm-gateway/home.md` — **reported** |
| Support channel | Slack `#llm-gateway-express-support` (gateway admins answer there) — **reported** |

Despite the `preprod` in the hostname, this is the host everyone uses, including for production workloads. No separate "prod" host is referenced in Slack — **reported**.

## 2. Authentication

Keys are LiteLLM virtual keys issued through DevBar:

```bash
/Applications/devbar.app/Contents/MacOS/devbar auth claude   # prints the key; capture it, don't echo it
```

Send it as a Bearer token. Anthropic-style requests also need `anthropic-version`:

```bash
export SF_LLM_KEY="$('/Applications/devbar.app/Contents/MacOS/devbar' auth claude | tail -1)"
GW=https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl

curl -s "$GW/v1/messages" \
  -H "Authorization: Bearer $SF_LLM_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

Claude Code clients also send `x-sf-ai-harness-client-id: claude` (set via `ANTHROPIC_CUSTOM_HEADERS`) — **reported**. KB Agent's direct `/v1/messages` calls work without it — **verified**.

## 3. Endpoints

| Endpoint | Purpose | Status |
|---|---|---|
| `POST /v1/messages` | Anthropic Messages API (streaming via `"stream": true`, SSE) | **verified** |
| `POST /v1/chat/completions`, `/chat/completions` | OpenAI-compatible chat | **reported** |
| `POST /v1/responses` | OpenAI Responses API (used by Codex) | **reported** |
| `/bedrock/...` | Bedrock-compatible path used by Claude Code in Bedrock mode | **reported** |
| `GET /v1/models` | Models your key can call | **verified** |
| `GET /model_group/info` | Per-model metadata incl. pricing and capability flags | **verified** (`/v1/model_group/info` also **reported**) |
| `GET /model/info` | Per-deployment model info | **verified** (200) |
| `GET /key/info` | Your key's limits and lifetime spend | **verified** |
| `GET /user/info` | Monthly spend/limits per user | **reported**; returned 403 for the key tested |
| `GET /health/readiness` | Gateway health | **verified** |
| `/team/info`, `/budget/list`, `/global/spend` | Admin-scoped | 403 for normal keys — **verified** |

## 4. Discovering available models

```bash
curl -s "$GW/v1/models" -H "Authorization: Bearer $SF_LLM_KEY" -H "anthropic-version: 2023-06-01" \
  | jq -r '.data[].id' | grep '^claude-' | grep -v auto-model | sort
```

- The list is **per key** and includes non-Claude models (`gpt-*`, `gemini-*`, `grok-*`, …). An unprovisioned key returns `{"id":"no-default-models"}` — **reported**.
- Being listed doesn't guarantee a call succeeds — send a 5-token test call to confirm.
- Model ids come in variants for the same model: bare (`claude-sonnet-5-5`), `-vertex` (`claude-sonnet-5-5-vertex`), and dated snapshots (`claude-haiku-4-5-20251001`). Pricing can differ between variants (e.g. `claude-sonnet-5` vs `claude-sonnet-5-vertex` were reported at different rates by `/model_group/info`).
- Skip `*auto-model-preview` ids; they are routers, not fixed models.

Claude ids confirmed callable on 2026-10-05 (**verified**): `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-opus-5-5-vertex`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.

**How KB Agent uses this:** `refreshModelCatalog()` in `shared/gateway.js` fetches `/v1/models` (plus `/key/info` limits and `/model_group/info` pricing, each with a 12s timeout), keeps `claude-*` ids, and fills the Settings model dropdowns. It refreshes at most every 24h (or on "Refresh models"), with a static fallback list in `shared/config.js`.

## 5. Temperature and other unsupported parameters

Newer Claude models only accept the default temperature. Sending any other value is rejected with **HTTP 400** — **verified** against every Claude model on the gateway with `temperature: 0.1`:

| Accepts custom `temperature` | Rejects it (send no `temperature`) |
|---|---|
| Haiku 4.5, Sonnet 4 / 4.5 / 4.6, Opus 4.5 / 4.6 | Sonnet 5 / 5.5, Opus 4.7 / 4.8 / 5.5 (including `-vertex` variants) |

Typical errors:

```
litellm.UnsupportedParamsError: global.anthropic.claude-sonnet-5-5 does not support temperature=0.1. Only temperature=1 is supported. To drop unsupported params, set `litellm.drop_params=True`
BedrockException - {"message":"`temperature` is deprecated for this model"}
```

- Gateway admins confirmed this is expected: Anthropic deprecated `temperature` for these models — **reported**.
- `drop_params` is **not** enabled gateway-wide, so the gateway won't strip the parameter for you — **reported**. Omit it client-side.
- Other parameters reported to fail the same way on some Bedrock-routed models: `store` (claude-sonnet-5), `prompt_cache_key`, and `tools` / `reasoning_effort` for some non-Claude models — **reported**.
- `/model_group/info` lists `temperature` under `supported_openai_params` even for models that reject it — **verified** — so don't use that field to decide.

**How KB Agent handles it:** `supportsTemperature(model)` in `shared/gateway.js` only sends `temperature` for Opus < 4.7 and Sonnet/Haiku < 5, and omits it otherwise.

## 6. Output length and truncation

Check `stop_reason` in the response. `"max_tokens"` means the output was cut off, and JSON outputs won't parse. Newer models are wordier, so give JSON-producing calls generous `max_tokens` (KB Agent uses 4000, retrying once at 6000 for scoring). You're billed for tokens actually generated, not for the cap.

## 7. Costs

**Per-call cost (most accurate):** every `/v1/messages` response carries LiteLLM cost headers — **verified**:

| Header | Meaning |
|---|---|
| `x-litellm-response-cost` | Total USD cost of this call |
| `x-litellm-response-cost-input` / `-output` | Input / output portions |
| `x-litellm-response-cost-discount-amount` | Discount applied (was `0.0` in testing) |
| `x-litellm-model-name` | Backend deployment that served the call |
| `x-litellm-attempted-retries` / `-fallbacks` | Gateway-side retries/fallbacks |

**Per-model list prices:** `GET /model_group/info` returns `input_cost_per_token` and `output_cost_per_token` (USD per token; multiply by 1,000,000 for $/MTok) — **verified**:

```bash
curl -s "$GW/model_group/info" -H "Authorization: Bearer $SF_LLM_KEY" \
  | jq -r '.data[] | select(.model_group|test("^claude-")) | [.model_group, (.input_cost_per_token*1e6), (.output_cost_per_token*1e6)] | @tsv'
```

Prices reported on 2026-10-05 ($ per million tokens, input / output): Opus 5.5 4 / 20 · Opus 4.8 5 / 25 · Sonnet 5.5 and Sonnet 5 2 / 10 · Sonnet 4.6 3 / 15 · Haiku 4.5 1 / 5. Prompt-cache write/read rates are not exposed there.

**These are list prices.** Contracted Anthropic discounts exist (e.g. Haiku 4.5 at $0.50 / $2.50 after discount), but Finance applies them separately per model. The gateway's reported costs and `discount-amount` reflect list price — **reported** + **verified** (`discount-amount` = 0). Treat gateway-reported cost as an upper bound.

**Your spend:**
- `GET /key/info` → `info.spend` (lifetime USD for the key) — **verified**.
- `GET /user/info` → monthly spend/limits — **reported**.
- Tableau "LLM Cost Analytics" dashboard (look up by your email) — **reported**.

**How KB Agent handles it:** `shared/cost.js` prices each call from the gateway's `/model_group/info` prices (cached with the model list), then falls back to the static table in `shared/config.js`, then to a model-family rate (never $0).

## 8. Rate limits

**Your own limit — query it, don't guess:**

```bash
curl -s "$GW/key/info" -H "Authorization: Bearer $SF_LLM_KEY" \
  | jq '.info | {rpm_limit, tpm_limit, max_parallel_requests, max_budget, budget_duration, spend}'
```

| Field | Typical value | Notes |
|---|---|---|
| `rpm_limit` | 50 by default; 100 if raised | Requests per minute per key. Admins raise 50 → 100 on request; "beyond 100 would be challenging" — **reported**. The key tested had 100 — **verified** |
| `tpm_limit`, `max_parallel_requests` | `null` | Not enforced per key for the key tested — **verified** |
| `max_budget`, `budget_duration` | `null` here | Some keys/teams have USD budget caps (e.g. $150 → $300 increases requested) — **reported** |

**Requesting a higher limit:** post in `#llm-gateway-express-support` with your email, org, a one-line use case, and current vs desired RPM. Non-T&P orgs may need the Claude Code CLI access request form and VP approval — **reported**.

**When you exceed it:** HTTP **429**, with no `Retry-After` header (**verified** none on normal responses; **reported** for 429). The reset time is in the message body:

```
429 Rate limit exceeded for user:<id>. Current limit: 50, Remaining: 0. Limit resets at: 2026-07-29 05:25:42 UTC
```

Other throttling to expect — **reported**:
- Backend capacity 429s, e.g. `litellm.RateLimitError: BedrockException - "Too many tokens, please wait again"`.
- Organization-wide token caps on some shared models (seen on `gpt-5.6-*`: 40M TPM shared across all callers).
- Occasional silent stalls under heavy concurrency. Lower concurrency and use prompt caching.

A burst of 25 concurrent tiny calls on a 100-RPM key all succeeded — **verified**.

**Recommended client behaviour (what KB Agent does):**
1. **Throttle client-side** to about 90% of `rpm_limit` (read from `/key/info`), shared across every caller using the same key. KB Agent's `shared/rate-limiter.js` shares one budget across the service worker and every open extension page (each context writes its own `chrome.storage.session` key and counts all of them), and falls back to 48/min if the limit can't be read.
2. **Retry transient errors** (408, 429, 500, 502, 503, 504, 529) up to 3 times. Wait for `Retry-After` if present, else the body's "Limit resets at" time, else exponential backoff (~1s, 2s, 4s + jitter), capped at 30s per wait. Each retry re-acquires a rate-limit slot, and abort signals cancel the wait (`postMessages()` in `shared/gateway.js`).
3. **Never retry 4xx validation errors** (400, 401, 403, 404) — fix the request instead.
4. **Bound every request.** Each attempt has a 90s limit until response headers arrive (non-streaming bodies get another 90s to download), and streams abort after 30s without data. A timeout throws a `TimeoutError`, distinct from a user abort. Mid-stream SSE `error` events (e.g. `overloaded_error`) fail the call instead of returning partial text.
5. **Validate a key for free** with `GET /key/info` rather than a `/v1/messages` ping. KB Agent also treats `spend >= max_budget` as not ready and caches a successful check for 5 minutes.

## 9. Quick checklist for a new integration

- Get a key via `devbar auth claude` and keep it out of code and logs.
- Check `/v1/models` and `/key/info` for your key.
- Omit `temperature` for Sonnet ≥ 5 and Opus ≥ 4.7.
- Set generous `max_tokens` for JSON outputs and check `stop_reason`.
- Throttle below `rpm_limit` and retry 429/5xx with backoff.
- Read cost from `x-litellm-response-cost`. It's list price, so contracted discounts are lower.
