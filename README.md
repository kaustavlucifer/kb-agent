# KB Agent v2.19.0

AI-powered Knowledge Base quality management for Salesforce Industry & Revenue Cloud. Chrome Extension (Manifest V3) that analyzes support cases, generates KB articles, scores existing content, and identifies duplicates — optimized for Agentforce retrieval.

## Features

### Case Analysis
- Paste a case number/URL/ID to trigger full AI analysis
- Progressive rendering: case details, summary, and metadata stream in real-time
- AI determines whether to create new articles, update existing ones, or take no action
- Full article rewrites streamed with live preview during generation
- Hypothesis identification for uncertain claims requiring SME validation
- Stop processing at any time (aborts in-flight AI calls immediately)

### KB Article Scoring
- 10-criterion quality scoring against Agentforce writing standards
- Dynamic max-point redistribution for N/A criteria (no images, no code, etc.)
- Batch scoring with concurrent processing
- AI-powered full article rewrite with streaming output

### Known Issues Integration
- Connects to the Known Issues org (known-issues-prd1) via cookie-based auth
- SOSL search with Cloud and Status filtering matched to Industry/Revenue verticals
- AI-ranked relevance scoring against the case context
- Related KIs displayed in sidebar and used as context during generation
- **Known Issues tab**: AI-drafts a new KI (Subject/Summary/Repro/Workaround) from a case, or rewrites an existing KI — both land as a Draft `Known_Issue__c` record only; submitting for approval stays a manual step in the Known Issues org, by design. Content is written with KI's public-facing rules (help.salesforce.com/s/issues) — stricter redaction than KB articles, including partial masking of any Salesforce record ID that slips through

### Duplicate Detection
- Pairwise similarity detection across the article corpus
- AI-powered merge suggestions with streaming output
- Confidence scoring and deduplication recommendations

## Architecture

```
kb-agent/
├── shared/              Core layer (service worker + popup)
│   ├── config.js          Constants, models, thresholds
│   ├── state.js           Observable state (setState/subscribe)
│   ├── auth.js            SF session detection (OrgCS, GUS, KI)
│   ├── api.js             Salesforce API helpers (SOQL, SOSL, REST)
│   ├── gateway.js         Claude AI gateway (streaming, abort signals)
│   ├── rate-limiter.js    Shared limiter sized from the gateway key's rpm_limit
│   ├── storage.js         chrome.storage helpers
│   ├── signature.js       Chatter usage-signature markers (post + classify)
│   └── ui.js              h(), chip(), modal(), toast(), spinner()
├── background/
│   ├── service-worker.js  Message router + article preloader
│   ├── update-check.js    Google Drive version check (mirrors Open Case Analyser)
│   ├── signature-audit.js SOSL sweep + aggregation for Usage Analytics
│   └── handlers/          Backend logic (no DOM)
│       ├── case-analysis.js   Full analysis pipeline
│       ├── kb-scorer.js       Scoring + rewrite streaming
│       ├── ki-enrichment.js   Known Issues search + ranking
│       ├── ki-publish.js      Known Issue AI draft/rewrite + create/update
│       ├── gus-enrichment.js  GUS work item fetch
│       ├── dedup.js           Duplicate detection
│       └── article-publish.js Article creation/update in OrgCS
├── modules/             UI modules (popup page context)
│   ├── app.js             Tab shell, header, connection chips
│   ├── case-analysis.js   Case tab: progressive UI, streaming, results
│   ├── kb-scorer.js       KB Articles tab: filters, scoring, rewrite
│   ├── ki-manager.js      Known Issues tab: draft from case, search, rewrite
│   └── dedup.js           Duplicates tab
├── data/
│   ├── writing_guide_prompts.js  AI prompt guides (generation, scoring, style)
│   ├── pt_routing.js             Product & Topic routing/keyword matching
│   └── ki_mapping.js             KI Cloud__c to vertical mapping
├── styles/
│   ├── tokens.css         Design tokens
│   └── app.css            Component styles
├── popup.html             Standalone tab entry point
├── options.html           Settings page
└── manifest.json          Manifest V3
```

## Setup

1. Clone the repo
2. Open `chrome://extensions` → Enable Developer Mode → Load Unpacked → select this directory
3. Click the KB Agent icon (opens as a full tab)
4. Log into the following orgs in the same browser:
   - **OrgCS** (orgcs.lightning.force.com) — required for case data and KB articles
   - **GUS** (gus.lightning.force.com) — optional, enriches analysis with work item context
   - **Known Issues** (known-issues-prd1.lightning.force.com) — optional, surfaces related KIs
5. Set the AI Gateway token via the "AI" chip in the header

## Auth Status

The header shows connection chips for each integration:
- **OrgCS** — green when Salesforce session detected
- **AI** — green when gateway token is valid
- **GUS** — green when GUS session active
- **KI** — green when Known Issues org session active

All auth is cookie-based (detected from browser sessions). No credentials are stored.

If any portal (OrgCS, GUS, Known Issues) is disconnected, a background tab for its login page opens automatically — no need to hunt down the URL yourself. It won't repeat for the same outage (and skips opening if a matching tab is already open), but resets the moment that portal is reconnected, so a later logout triggers a fresh auto-open. Connections are re-checked every ~10-15s while anything is down, with checks stopping once everything is healthy.

A manual "⬆ Check" button sits beside the connection chips — click to force a check against Google Drive; it shows "Checking…", then "✓ Current" or "⬆ v{x.y.z}" if an update is available.

## Updates

On launch, the popup checks a Google Drive-hosted zip for a newer version (requires being signed in to Google with your work account — the file is domain-shared, not public). If a newer version is found, an "⬆ v{x.y.z} available" chip appears in the header; clicking it opens a modal with a download link and reinstall steps (`chrome://extensions` → remove old → Load Unpacked). The check is cached for 30 minutes and a dismissed version won't re-prompt until a newer one ships.

## AI Gateway

Uses the Salesforce internal AI model gateway (see [SF_CLAUDE_API.md](SF_CLAUDE_API.md)). Models are discovered per user and default to Claude Sonnet 5.5. Requests are rate limited client-side to 90% of the key's `rpm_limit` from `/key/info` (fallback 48/min), shared across popup and service worker; transient gateway errors (429/5xx/529) are retried with `Retry-After` or exponential backoff. All AI calls support abort signals for immediate cancellation.

## Key Behaviors

- **Progressive rendering**: Case details, summary, and metadata appear as soon as available — no waiting for full analysis to complete
- **Streaming**: Article rewrites and new drafts stream progressively with live JSON parsing
- **Stop processing**: Cancels all in-flight AI and network calls immediately
- **Resizable sidebar**: Drag the divider to resize (persisted across sessions)
- **Article preview**: Eye icon on sidebar articles opens a modal with full content
- **Relevance tooltips**: Hover scores to see AI reasoning
- **ORGCS navigation**: After publishing, a button navigates directly to the new article
- **Refine**: Re-generate articles or sections with a specific focus instruction

## Usage Analytics

Every case scan, article score, rewrite generation, and rewrite publish is tagged with an internal (not customer-visible) Chatter post on the Case or Article — a signature marker, not a comment anyone needs to read. Settings → Usage Analytics runs an org-wide SOSL search for these markers across the last 3 months and shows: totals by action type, a by-month breakdown, a by-user breakdown, and a per-record (case/article) drill-down. This is for team-level adoption tracking, not per-interaction audit — the posts carry no case/article content, just a timestamp and the acting user's name.

## KB Chatter as AI Context

When scoring or rewriting a KB article, the tool also reads that article's own Chatter feed (filtered to `Type = 'TextPost'`, excluding its own tracking markers) and passes it to the AI as optional context, redacted for PII first. The AI is told these notes may include SME corrections worth factoring in, or may be irrelevant/automated noise — it decides what to use, nothing is pre-scored as article content.

## Changelog

### v2.24.2 (current)
- Fixed Known Issue creation failing with `INVALID_FIELD_FOR_INSERT_UPDATE` on `Cloud__c`: the Cloud selector is removed from the KI create dialog and `Cloud__c` is no longer written (it is not writable in the KI org)
- Case analysis "no action" now distinguishes "existing articles cover this" from "not KB material yet" (defect pending a fix, customer-specific, no documentable resolution); the latter shows "No KB Action Recommended" with "Related Articles" instead of "Existing Coverage is Adequate" / "Covering Articles"

### v2.24.1
- Case analysis now reads the case's GUS links from OrgCS `Case_Relationship__c` (Case GUS Relationship) in addition to W-numbers in comments; previously cases linked only via that object got no GUS context and no KI suggestion
- GUS context (record type, status, follow-up work) is passed to the case summary, KB coverage evaluation, KI decision, and KI draft prompts
- A defect linked through Case GUS Relationship qualifies for a KI even if the AI issue-type classification disagrees
- "New Bug Logged" investigations whose bug was converted to a User Story use that story as the KI Work ID (a linked Bug is still preferred)
- GUS subjects have their customer prefix (e.g. "Premier - <case#> - <account> -") stripped before reaching the public KI draft prompt

### v2.24.0
- Fixed `MALFORMED_QUERY: FeedItem requires a filter by Id` in case analysis and KB scoring/rewrite: article Chatter now reads `Knowledge__Feed` via the master `KnowledgeArticleId`
- Case analysis article drafts/rewrites no longer show raw HTML tags: prompts require Markdown (shared `MARKDOWN_OUTPUT_RULE`), and any stray HTML is converted to Markdown before display and Refine
- KB vs KI vs no-action decision tightened:
  - Coverage-evaluation failures now fall back to "No KB action" (low confidence) instead of auto-generating updates
  - Customer-specific cases get no KB action (previously only a warning banner)
  - Cases are classified as product defect / configuration-how-to / other; a KI draft is only suggested for product defects, independent of KB coverage
  - GUS record type and status drive KI eligibility: Bugs count unless closed as Duplicate / Not a bug / Never / Not Reproducible / Won't Fix etc.; Investigations count only when closed "New Bug Logged" or "Known Bug Exists"; open Investigations show "revisit once engineering confirms a bug"; User Stories/ToDos never count
  - Investigations resolve their linked Bug (`ADM_Parent_Work__c`), which becomes the KI's Work ID
  - The coverage evaluator sees issue type and linked GUS items; Doc/Usability or Working-as-Documented investigations count toward KB, pending-fix-only defects toward KI
- Known Issue create dialog: GUS Work lookup (search by W-number or subject across Bugs/Investigations) to change, link, or clear the pre-selected work item

### v2.23.0
- KI rewrite now scores first: if the KI already meets the good-enough threshold you get an "Already high quality" prompt with "Rewrite anyway"; otherwise it rewrites automatically and scores the result
- KI rewrite and scoring stream from the popup (like KB), with a live section-by-section preview
- KI rewrite modal matches KB: Compare / Regenerate / Update KI in the header, score badges (current and new), Close-only footer; Compare and score details open inline
- KI score, rewrite, rewrite score, and edits persist across closing/reopening the modal and popup reloads (until regenerated/rescored); jobs keep running when the modal is closed
- KI table: sortable Score column that updates as soon as a KI is scored; Rewrite shows "Rewriting…" / "Rewrite •" status
- KI prompts consolidated in `shared/ki-prompts.js` (shared by popup and service worker)

### v2.22.2
- Fixed a syntax error in `shared/config.js` (unescaped apostrophe in a settings help string) that stopped the service worker from registering in v2.22.1

### v2.22.1
- Gateway retry: transient errors (408/429/5xx/529) retry up to 3x, honoring `Retry-After`, then the gateway's "Limit resets at" time, then exponential backoff (capped at 30s); abort cancels the wait
- Client rate limit now sized to 90% of your key's `rpm_limit` from the gateway's `/key/info` (fallback 48/min), shared across popup and service worker
- New [SF_CLAUDE_API.md](SF_CLAUDE_API.md): internal gateway reference — auth, endpoints, model discovery, temperature caveats, costs, and rate limits

### v2.22.0
- Known Issues: AI scoring/rewrite inputs are PII-masked; rewrites build on a pending DRAFT instead of overwriting it; Summary/Repro/Workaround are saved as Salesforce rich text (so lists render on help.salesforce.com); KI Chatter read from `Known_Issue__Feed`; scoring no longer truncates (larger token budget + retry); category Id cache scoped per org; BRE cases resolve to the correct KI cloud
- KI rewrite modal now has an instructions box and Regenerate (builds on your current edits), matching the KB rewrite flow
- KI table: Created and Modified date columns (sortable); layout aligned with KB/Dedupe (sticky toolbar, table in its own card)
- Case Analysis: layout aligned with other tabs; previous case's warnings no longer leak into the next analysis; auto-retry only on early disconnects (no silent full AI re-run); Stop now cancels all AI and Chatter calls
- KB: publish lock prevents duplicate drafts from double-clicks (KB rewrite, Dedupe merge, Case Analysis); rewrite state resets after publish; KB rewrite and Dedupe merge now share the writing guide rules (merges previously received none)
- Security: rewrite image fetches only send the OrgCS session to OrgCS's own hosts; no silent fallback to a non-OrgCS org when OrgCS isn't logged in
- Settings: new Updates section; Usage Analytics always expanded; analytics records link to their Case, KB article, or Known Issue
- Org hosts centralized in config; dead CSS and duplicate mapping entries removed

### v2.21.1
- Fixed Gateway 400 "does not support temperature" on newer models: temperature is now only sent to models that accept it (Haiku 4.5, Sonnet ≤4.6, Opus ≤4.6) and omitted for Sonnet 5/5.5 and Opus 4.7+/5.5, which use their default — verified against every Claude model on the gateway

### v2.21.0
- Model choices are now discovered per user from the AI gateway (Settings → Models, with a "Refresh models" button; auto-refreshed daily, static fallback list). All model settings default to Claude Sonnet 5.5; Known Issue drafting/rewriting/scoring now follow the Scoring model setting
- Cost tracking uses the gateway's own per-model pricing, falling back to a static table and then a model-family rate (never $0). Pending cost is flushed when the popup closes, and scoring/dedup estimates use the live prompt length
- Fixed Known Issue creation: `Category__c` is a lookup, so the category name is now resolved to its record Id before creating
- Fixed KI suggestions being suppressed when relevance ranking returned no score, and "Covered by" links now use the authenticated Known Issues org host
- Cross-scope search race fix (stale results can't overwrite newer ones) on both tabs; cross-scope KB articles now work with scoring progress, score details, and case-analysis deep links
- Usage Analytics: both orgs swept in parallel with MV3 keepalive and abort-on-close; de-duplicated orgs, page-boundary rows, and cross-org records; partial failures now flagged as incomplete instead of shown as low counts
- KI suggestion now runs concurrently with KB draft generation (and is cancelled by Stop); KB scoring/rewrite fetch article bodies and Chatter in parallel
- Shared rate limit between popup and service worker without lost updates; KI list cache invalidated after create/update; swallowed KI/GUS errors now surfaced; Clear Cache covers auth and merge caches; merge stream stops on tab switch
- UI: KB table now sits in a card like the KI tab; KI table is sortable by any column; "Duplicates" tab renamed "KB Dedupe"
- Shared UI helpers (score colors, cross-scope toggle, pagination bar, async modal, field labels) replace duplicated KB/KI code; dead code and unused CSS removed

### v2.20.0
- Case Analysis now suggests a Known Issue draft or links an existing one directly from the regular case-scan flow (no separate KI case-input step) — only suggested when the case has a linked GUS work item, since KIs can't be created without one
- Known Issues tab: full-list pagination (not a 25-row cap), category filter scoped to a fixed 33-category list, Name/Subject/Cloud/Category/Status/Created By/Approver/Impacted-count columns, and a combined View/Score/Rewrite Actions column
- KI View popup now renders Summary/Repro/Workaround in the same bordered preview boxes as the KB article preview, with the linked Work Item (GUS WorkLocator link) shown inline instead of as a table column
- Fixed `createKnownIssue`/`updateKnownIssue` to write the org's real required `DRAFT*` shadow fields (`DRAFTSubject__c`/`DRAFTSummary__c`/`DRAFTRepro__c`/`DRAFTWorkaround__c`) and `Category__c`, verified against real `Known_Issue__c` schema/data — the previous version targeted the wrong (live) fields and a required field that wasn't being set
- Cross-scope live search for both KB Articles and Known Issues: a "Search all clouds/categories" checkbox next to each search box bypasses the configured scope and runs a live unscoped Salesforce search, so you can score/rewrite an article or KI outside the usual restriction. Count/stats rows hide while this is active
- Usage Analytics now also instruments and audits KI actions (created, updated, rewrite generated, scored) across both the OrgCS and Known Issues orgs, merging both into one report
- Fixed Recent Cases list not clearing on Clear Cache
- KB Articles stats line is now a single small subtle text row (matching the KI tab) instead of the large stat-card bar, placed below the search/filter row

### v2.19.0
- New Known Issues tab: AI-drafts a new KI from a case, or rewrites an existing one, each landing as a Draft `Known_Issue__c` record (no auto-submit-for-approval — that stays manual in the Known Issues org)
- KI content follows public-facing writing/redaction rules (stricter than KB articles): no customer/employee names, partial masking of any 15/18-char Salesforce ID, fixed Subject/Summary/Repro/Workaround structure
- KI rewrite also factors in that KI's own Chatter notes, reusing the same filtered/redacted chatter-context pipeline built for KB articles
- Shared-layer reuse pass: generalized `parseRewriteSections`/`serializeRewriteSections` and `sectionsEditor` to accept any field list (not just KB's Title/Summary/Description/Resolution), and extended `redactPii` with an opt-in Salesforce-ID-masking mode — both KB and KI now share the same section-editor and PII primitives instead of parallel copies

### v2.18.0
- Usage-analytics Chatter signatures: case scans, article scores, rewrite generations, and rewrite publishes are each tagged with an internal Chatter marker on the Case/Article
- Settings → Usage Analytics: org-wide report (by month, by user, per-record) built from a SOSL search over those markers
- KB article Chatter is now pulled in (filtered + PII-redacted) as optional AI context during scoring and rewriting, both in the KB Articles tab and during case-driven article updates

### v2.17.0
- Auto-open login tabs for disconnected portals (OrgCS, GUS, Known Issues) — no manual tab-hunting needed
- Update button in connection chips row (⬆ Check) with manual re-check, status feedback (Checking… / Failed / Current / or shows latest version available)
- Settings page now shows app version below title, collapsible Models & Thresholds sections (collapsed by default), non-collapsible Guard rails header
- Periodic ~10-15s auth re-checks while any portal is disconnected, auto-reset when all recover

### v2.16.0
- In-app update check against Google Drive, mirroring Open Case Analyser — header chip + modal with download link and step-by-step reinstall instructions
- Collapsible sections (Models, Thresholds, Guard rails) on the Settings page

### v2.15.0
- Preserve links/images in article rewrites, vision-based image review
- PII redaction gap fixed in article-update flow, cost-flush race fixed
- Rulebook compliance alignment, draft-overwrite confirmation, guard-rail/abort fixes
- Rich-text merge with publish/caching, dedup coverage upgrades, scoring robustness
- See `git log` for the full per-release history between v2.2.0 and v2.15.0

### v2.2.0
- Progressive streaming layout (case details render immediately)
- Known Issues org integration (auth, search, AI ranking, sidebar)
- Stop processing with full abort signal propagation
- Resizable left sidebar (320px default, drag to resize)
- Article preview modal, relevance score tooltips
- Case completeness indicator, P&T detection pills
- ORGCS navigation button after publish
- KB writing style: product-doc tone, no case-specific data leakage
- Fenced code block rendering in markdown
- Inline formatting support (**bold**, *italic*, `code`)
- Whole-article Refine with focus input
- Product doc gap assessment bias fix (conservative by default)
- Scoring error handling (no more silently skipped articles)
- Dead code cleanup, prompt consolidation

### v2.1.0
- Initial unified release (ported from 4 source extensions)
- Case analysis, KB scoring, P&T coverage, duplicate detection
- GUS enrichment, hypothesis identification
- Agentforce writing guide integration
