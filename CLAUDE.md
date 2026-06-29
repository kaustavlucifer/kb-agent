# KB Agent — Project Instructions

## Comments
Never add comments to code. No single-line comments, no block comments, no inline comments, no JSDoc. Code should be self-explanatory through naming. This rule has no exceptions.

## Console statements
Never add console.log, console.info, console.warn, console.error, or console.debug calls. Remove them if encountered.

## Code style
- No error handling, fallbacks, or validation for scenarios that can't happen
- No abstractions beyond what the current task requires
- No backwards-compatibility shims or unused code — delete it
- Default exports are named; no anonymous default exports

## Chrome MV3 constraints
- No dynamic `import()` inside the service worker (`background/service-worker.js`) — all imports must be static top-level
- `mapWithConcurrency(items, concurrency, fn)` — concurrency is the second argument
- Settings are applied via `applySettings()` at startup in BOTH the popup (`modules/app.js init()`) and service worker (`_settingsReady` promise); both contexts must call it

## Architecture
- Scoring and rewrite call `streamClaude` directly from the **popup** context
- Case analysis, coverage, dedup run in the **service worker** via ports
- `shared/config.js` exports are `let` bindings — `applySettings()` reassigns them in place; all `import { X }` call sites see the new value automatically
- `shared/markdown.js` is the ONE markdown parser — never reimplement it
- `shared/ui.js` is the ONE UI helper — `h()`, `modal()`, `toast()`, `spinner()`, etc.

## Salesforce Knowledge__kav
- `Product_And_Topic__c` is nillable but has a required org lookup filter — see `patchArticleSavingContent` in `background/handlers/article-publish.js` for the stale-tag handling pattern
- One Draft per master article — check for existing draft before POSTing a new version
- `KNOWLEDGE_ARTICLE_RT_ID = '012Hx00000002oEIAQ'` is hardcoded for new-article creation (Knowledge Article record type)
