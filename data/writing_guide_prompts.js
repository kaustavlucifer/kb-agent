export const GUIDE_GENERATION = `AGENTFORCE KB WRITING RULES — follow strictly when creating or rewriting articles:

TITLE: Must be specific to the product AND the exact issue. Include product name, error text, or scenario. Example: "Troubleshooting Tableau Prep Flows" not "Troubleshooting Flows". If the article is specific to a customer segment, include that (e.g. "Salesforce.org Trial Extensions for Nonprofits").

SUMMARY: 2-4 sentences covering problem context and resolution approach. Used by Agentforce for retrieval but not directly shown to customers on the help portal.

HEADERS: Use H2/H3 header tags to break content into logical sections. NEVER use bold text as a substitute for headers. Agentforce chunking uses header tags to split articles into structured pieces for Data Cloud vectorization. Poor headers = poor chunking = poor retrieval.

DESCRIPTION SECTION: State the problem, symptoms, and context clearly. Explain WHY this happens — root cause context helps the LLM form better answers. Include the product name with feature terms to avoid ambiguity across clouds (e.g. "Revenue Cloud Billing Schedules" not just "Billing Schedules").

RESOLUTION SECTION: Begin with a brief statement of what the steps accomplish. Then provide numbered steps. After code blocks, always add a plain-text explanation of what the code does — Agentforce does not consume code blocks well in isolation.

GENERAL RULES:
- Explain acronyms and abbreviations (BDR = Business Development Representative). API does not need explanation.
- Use simple present tense.
- Give real-life Salesforce examples when information is complex.
- Tables must use text, NOT visual indicators (checkmarks, circles). Tables with text work for both full-table and single-row responses.
- Do NOT copy/paste tables from external sources — use built-in table features.
- Each FAQ item must be very specific in intent and solution. Large FAQs are not consumed well.
- Long articles should spread content across Description and Resolution with distinct headers, not put everything in one section.
- Videos and images are NOT served to customers via Agentforce, but alt-text descriptions ARE chunked and vectorized. Always annotate media with descriptive alt text.
- The Additional Resources section IS used by Agentforce for citations.`;

export const GUIDE_SCORING = `AGENTFORCE KB QUALITY STANDARDS — score articles against these criteria:
- Titles must be product-specific and describe the exact issue (not generic)
- Must use H2/H3 header tags for structure (bold text is NOT a substitute — it breaks chunking)
- Summary should be 2-4 sentences covering problem + resolution approach
- Description must state the problem, symptoms, context, and WHY it happens
- Resolution must start with what the steps accomplish, then numbered steps
- After code blocks, there must be plain-text explanation
- Acronyms must be explained on first use
- Tables must use text, not visual indicators (checkmarks/circles)
- Media must have alt-text descriptions
- Product name + feature must appear together to avoid cross-cloud ambiguity
- Content should be spread across sections with headers, not dumped in one block
- FAQ items must be specific in intent — large generic FAQs score poorly`;

export const GUIDE_DECISION = `AGENTFORCE KB COVERAGE ASSESSMENT — use these standards to judge whether existing articles adequately cover a case:
- An article "covers" a case if: same product + feature, same error/symptom pattern, resolution would directly help
- Articles that are generic to the product area but don't address the specific error/scenario do NOT constitute adequate coverage
- A well-written article (proper headers, specific title, clear resolution steps) is more likely to be surfaced by Agentforce than a poorly structured one
- Articles missing product-specific context in the title/description may exist but fail to be retrieved by Agentforce chunking
- If an article exists but has poor structure (no headers, generic title, missing resolution), it may need updating even though the content is there
- Trivial cosmetic improvements (punctuation, minor wording) do NOT justify an update action`;
