# KB Agent v2.2.0

AI-powered Knowledge Base quality management for Salesforce Industry & Revenue Cloud. Chrome Extension (Manifest V3) that analyzes support cases, generates KB articles, scores existing content, detects coverage gaps, and identifies duplicates — optimized for Agentforce retrieval.

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

### P&T Coverage
- Agentforce conversation cluster analysis against KB coverage
- Per-P&T gap detection with AI-powered assessment
- Coverage recommendations for under-served product areas

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
│   ├── rate-limiter.js    48 RPM shared limiter
│   ├── storage.js         chrome.storage helpers
│   └── ui.js              h(), chip(), modal(), toast(), spinner()
├── background/
│   ├── service-worker.js  Message router + article preloader
│   └── handlers/          Backend logic (no DOM)
│       ├── case-analysis.js   Full analysis pipeline
│       ├── kb-scorer.js       Scoring + rewrite streaming
│       ├── ki-enrichment.js   Known Issues search + ranking
│       ├── gus-enrichment.js  GUS work item fetch
│       ├── coverage.js        P&T gap analysis
│       ├── dedup.js           Duplicate detection
│       └── article-publish.js Article creation/update in OrgCS
├── modules/             UI modules (popup page context)
│   ├── app.js             Tab shell, header, connection chips
│   ├── case-analysis.js   Case tab: progressive UI, streaming, results
│   ├── kb-scorer.js       KB Articles tab: filters, scoring, rewrite
│   ├── coverage.js        P&T Coverage tab
│   └── dedup.js           Duplicates tab
├── data/
│   ├── writing_guide_prompts.js  AI prompt guides (generation, scoring, style)
│   ├── pt_routing.js             Product & Topic routing/keyword matching
│   ├── ki_mapping.js             KI Cloud__c to vertical mapping
│   └── pt_clusters.json          Agentforce conversation clusters
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

## AI Gateway

Uses the Salesforce internal AI model gateway with Claude Sonnet 4.6. Rate limited to 48 requests per minute (shared across all operations). All AI calls support abort signals for immediate cancellation.

## Key Behaviors

- **Progressive rendering**: Case details, summary, and metadata appear as soon as available — no waiting for full analysis to complete
- **Streaming**: Article rewrites and new drafts stream progressively with live JSON parsing
- **Stop processing**: Cancels all in-flight AI and network calls immediately
- **Resizable sidebar**: Drag the divider to resize (persisted across sessions)
- **Article preview**: Eye icon on sidebar articles opens a modal with full content
- **Relevance tooltips**: Hover scores to see AI reasoning
- **ORGCS navigation**: After publishing, a button navigates directly to the new article
- **Refine**: Re-generate articles or sections with a specific focus instruction

## Changelog

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
