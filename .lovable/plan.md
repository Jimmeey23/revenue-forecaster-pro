A lot of distinct issues, all touching `src/main.js` / `src/main.css` / `index.html`. Grouping into phases so we can ship incrementally and you can sanity-check each.

## Phase 1 — Metric cards (Overview)
- Fix grid: force `repeat(5, minmax(0,1fr))` at ≥1280px (4 at md, 2 at sm) so cards always lay out as a row of up to 5.
- Shrink card padding / font-size by ~10% so 5 fit comfortably.
- Move the `?` help icon out of the metric value area: dock it to the top-right corner of the card with absolute positioning, smaller hit target, tooltip-on-hover only. No more overlap with the number.

## Phase 2 — Drill-down modal shows real item-level data
Today `kpiDrill()` and several table drills push the same headline rows back into the drawer. Rework so each drill resolves to underlying records:
- Sales KPIs → list the top N sales rows (member, product, ATV, date) from the sales array filtered to the studio + period.
- Class / format / trainer drills → list the actual session rows (date, time, trainer, format, booked, attended, fill).
- Lead source drill → list the actual lead rows (date, source, stage, owner, status) for that source.
- Member / churn drills → list member rows (name masked, last visit, expiry, MV used, status).
Each drill panel keeps the small "context summary" header, but the body becomes a paginated record table (first 50 rows, with a "showing X of Y" line).

## Phase 3 — Lead Source Conversion (empty fix)
- Audit `sourceTable` / `c.sources` build. If `sources` is empty for the current studio, fall back to deriving from `newTypes` or `leadSources` so the table renders instead of going blank.
- Add an explicit empty-state row ("No first-visit source data for this period") when truly empty so the section never silently disappears.

## Phase 4 — Editable & persistent summaries / AI briefs
Every summary block (`#businessSummary`, `#funnelSummary`, `#scheduleSummary`, `#executiveSummary`, all per-table insight slots) gets:
- An "Edit" pencil button → swaps the block into a `contenteditable` textarea with Save / Cancel.
- On Save: write `{ text, editedAt }` to `localStorage` keyed by `studio + period + blockId`.
- On render: if a saved override exists, render it (with a small "Edited" chip + "Reset to AI" link). Generating fresh AI insights clears the override for that block.

## Phase 5 — Universal "Insights & Learnings" panel under every chart / table / list
Introduce a single helper `renderInsightPanel(targetId, {observations, patterns, conclusions, actions})` that mounts a styled card directly under any chart/table/list. Wire it into:
- Overview metric strip, Revenue Trend, Funnel, Lead intake, Lead Source Conversion, CRM Lead Pipeline, Schedule Efficiency Mix, Format/Trainer scorecards, Sales matrix, Membership breakdown, Churn list, Executive summary.
Content is auto-generated from the same data the block uses, and is itself editable via Phase 4.

## Phase 6 — Metric calculation explainers
Add a tooltip + drill "How this is calculated" section for: Gap %, MoM, Efficiency, Risk, Lead source conversion, Move, Fill %, Conversion %, Retention %, Churn risk, ATV, LTV. Definitions come from a single `FORMULAS` dictionary that the `?` tooltip and the drill's `formula` block both read from, so they stay in sync.

## Phase 7 — Visual restyle (Studio Health, Schedule Efficiency, tables, funnel)
Match the attached reference screenshots:
- **Tables** (Sales matrix, Trainer scorecard): dark card shell with rounded border, sticky first column, alternating row tint, MoM / Rankings / Discount-codes toggle chips top-right, copy-to-clipboard icon on the header.
- **Funnel** (Lead intake): big SVG funnel on left with `% drop` annotations on the right edge of each stage, right-side stage card with Stage Conv / Avg LTV / Conv Rate / Ret Rate KPIs and a "Source mix — this stage" bar list. Bottom strip with the AI insight bullets.
- **Studio Health & Executive Summary** and **Schedule Efficiency Mix** get the same dark card shell, a clear "what this summarises" header tied to the chart above it, and the editable insight body from Phase 4.

## Suggested order
1, 3, 2 first (highest-impact correctness fixes), then 7 (visual), then 4 + 5 + 6 (cross-cutting summary system).

## Notes / technical details
- All work stays in `src/main.js`, `src/main.css`, `index.html`. No backend changes required (overrides live in `localStorage`).
- The AI brief endpoints (`/api/management-readout`, `/api/table-insight`) keep their current contract; the override layer sits on top of their output.
- Phases 4 and 5 introduce a small `insights.js` module split out of `main.js` to keep the monolith from growing further.

Want me to start with Phase 1+3+2 in this pass, or kick off all 7 phases sequentially?