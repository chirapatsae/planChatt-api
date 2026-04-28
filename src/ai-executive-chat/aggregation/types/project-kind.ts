/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * Discriminator union for the three project-owning tables the executive
 * engine composes over:
 *   - `main`       → `ProjectGroup`
 *   - `revised`    → `RevisedProjectGroup`
 *   - `supplement` → `SupplementProjectGroup`
 *
 * This is a SERVICE-LAYER abstraction only. The DB retains three
 * distinct tables with three distinct FK shapes — the `projectKind`
 * discriminator is synthesised by `UnifiedProjectAggregator` at read
 * time (design memo §3.1).
 *
 * CLAUDE.md references:
 *   - §11 Versioning Rule — main / revised / supplement are three
 *     distinct persistence shapes; the engine unifies READS only.
 *   - §14 Project Lineage Immutability — reads allowed on locked rows.
 *   - §17.2 Advisory-only — no mutation implied by the discriminator.
 */
export type ProjectKind = 'main' | 'revised' | 'supplement';
