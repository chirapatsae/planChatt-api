import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * TemplateContextError — thrown when a template is rendered with missing
 * required context fields. This is treated as a NON-RETRYABLE coding bug
 * by the processor (§7 failure matrix).
 */
export class TemplateContextError extends Error {
  constructor(
    public readonly templateName: string,
    public readonly missingFields: string[],
  ) {
    super(
      `[Notify] template-context-invalid: template=${templateName} missing=[${missingFields.join(', ')}]`,
    );
    this.name = 'TemplateContextError';
  }
}

/**
 * Minimal Handlebars-compatible renderer for Wave 21.
 *
 * Scope (Phase 1):
 *   - `{{var}}` with HTML escaping (default-safe)
 *   - `{{{var}}}` triple-stache for pre-sanitized HTML (e.g. whitelisted reason body)
 *   - `{{> partial}}` partial inclusion (partials loaded at boot)
 *   - `{{#if var}}...{{/if}}` simple truthiness branch
 *
 * This is intentionally a small in-tree implementation to avoid adding the
 * `handlebars` dependency in Wave 21. The directory layout and `.hbs` file
 * format are compatible — swapping to real Handlebars later is a drop-in
 * replacement.
 *
 * NOTE for reviewers: if/when `handlebars` is installed, replace the body
 * of `compile` with `Handlebars.compile(source)` and keep the rest.
 */
@Injectable()
export class TemplateRendererService {
  private readonly logger = new Logger(TemplateRendererService.name);
  private readonly templateDir: string;
  private readonly compiled = new Map<
    string,
    (ctx: Record<string, unknown>) => string
  >();
  private readonly partials = new Map<string, string>();

  constructor() {
    this.templateDir = TemplateRendererService.resolveTemplateDir();
    this.logger.log(
      `[Notify] template directory resolved: ${this.templateDir}`,
    );
    this.loadPartials();
  }

  /**
   * Wave 93 hardening — `nest-cli.json` `assets` glob is supposed to copy
   * `.hbs` files into `dist/src/notifications/templates/`, but in practice
   * (`nest start` vs `nest build`, watch vs full build, deleteOutDir
   * timing) we have repeatedly observed the copy NOT happening, leading
   * to template-context-invalid file-not-found in DLQ.
   *
   * Resolution order — pick the FIRST directory that contains `_base.hbs`:
   *   1. Sibling of compiled __dirname (canonical: `dist/src/notifications/templates/`)
   *   2. Source tree fallback by walking up from `dist/src/...` to project root
   *      and joining `src/notifications/templates`. This works even when
   *      asset copy silently fails.
   *
   * Last-resort fallback returns the canonical sibling so the original
   * file-not-found error still surfaces in logs (better than silently
   * rendering a blank email).
   */
  private static resolveTemplateDir(): string {
    const candidates: string[] = [];

    // Candidate 1 — compiled sibling, e.g. `dist/src/notifications/templates`.
    candidates.push(path.join(__dirname, '..', 'templates'));

    // Candidate 2 — walk up to find a `src/notifications/templates` that
    // exists in the source tree. Handles both `dist/src/...` and
    // `dist/...` compile layouts.
    let current = __dirname;
    for (let i = 0; i < 8; i++) {
      const parent = path.dirname(current);
      if (parent === current) break;
      const sourceCandidate = path.join(
        parent,
        'src',
        'notifications',
        'templates',
      );
      if (fs.existsSync(path.join(sourceCandidate, '_base.hbs'))) {
        candidates.push(sourceCandidate);
        break;
      }
      current = parent;
    }

    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, '_base.hbs'))) {
        return dir;
      }
    }

    // Last resort — return the canonical sibling so the file-not-found error
    // still surfaces with a familiar path.
    return candidates[0];
  }

  private loadPartials(): void {
    // `_base.hbs` is the shared layout partial.
    const basePath = path.join(this.templateDir, '_base.hbs');
    if (fs.existsSync(basePath)) {
      this.partials.set('_base', fs.readFileSync(basePath, 'utf8'));
    }
  }

  /**
   * Render a template file by its base name (no `.hbs`). Returns the
   * rendered string (HTML). The caller is responsible for deriving a
   * plaintext representation and assembling the final EmailMessage.
   */
  render(
    templateName: string,
    context: Record<string, unknown>,
    requiredFields: string[] = [],
  ): string {
    const missing = requiredFields.filter((f) => {
      const value = this.lookup(context, f);
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      throw new TemplateContextError(templateName, missing);
    }

    let compiled = this.compiled.get(templateName);
    if (!compiled) {
      const filePath = path.join(this.templateDir, `${templateName}.hbs`);
      if (!fs.existsSync(filePath)) {
        throw new TemplateContextError(templateName, [
          `<file-not-found:${filePath}>`,
        ]);
      }
      const source = fs.readFileSync(filePath, 'utf8');
      compiled = this.compile(source);
      this.compiled.set(templateName, compiled);
    }
    return compiled(context);
  }

  /**
   * Strip HTML tags for plain-text fallback. Preserves line breaks for
   * readability. Not a full HTML-to-text pass (e.g. no entity decoding
   * beyond the common few) — sufficient for email clients that render
   * HTML anyway, and for accessibility scanners that read the text part.
   */
  toPlainText(html: string): string {
    return html
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Internal — minimal mustache-subset compiler
  // ---------------------------------------------------------------------------

  private compile(source: string): (ctx: Record<string, unknown>) => string {
    // Expand partials once at compile time.
    const expanded = source.replace(
      /\{\{>\s*([a-zA-Z0-9_-]+)\s*\}\}/g,
      (_match, name: string) => {
        const partial = this.partials.get(name);
        if (!partial) {
          this.logger.warn(`[Notify] partial-missing: ${name}`);
          return '';
        }
        return partial;
      },
    );

    return (ctx: Record<string, unknown>) => this.evaluate(expanded, ctx);
  }

  private evaluate(template: string, ctx: Record<string, unknown>): string {
    // {{#each array}}...{{/each}} — W105 BE-PR3 digest list support.
    // Iterates a context array, recursively evaluating the inner body with
    // a per-item child context. The child context shadows the parent for
    // any field names that collide. Two synthetic fields are injected:
    //   - `index0` — zero-based iteration index
    //   - `index1` — one-based iteration index (handy for numbered lists)
    //
    // Non-nested only — matches the existing `{{#if}}` constraint.
    // If the resolved value is not an array (or is null/undefined), the
    // block is silently elided. This mirrors the truthy-falsey behavior
    // of `{{#if}}` and avoids surfacing template typos as broken HTML.
    let out = template.replace(
      /\{\{#each\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_m, key: string, body: string) => {
        const value = this.lookup(ctx, key);
        if (!Array.isArray(value)) return '';
        return value
          .map((item, idx) => {
            const itemCtx: Record<string, unknown> = {
              ...ctx,
              ...(item !== null && typeof item === 'object'
                ? (item as Record<string, unknown>)
                : { this: item }),
              index0: idx,
              index1: idx + 1,
            };
            return this.evaluate(body, itemCtx);
          })
          .join('');
      },
    );

    // {{#if var}}...{{/if}} (non-nested, single-line or multi-line)
    out = out.replace(
      /\{\{#if\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_m, key: string, body: string) =>
        this.truthy(this.lookup(ctx, key)) ? body : '',
    );

    // {{{raw}}} — no escape
    out = out.replace(
      /\{\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\}/g,
      (_m, key: string) => {
        const v = this.lookup(ctx, key);
        return v === undefined || v === null ? '' : String(v);
      },
    );

    // {{var}} — HTML-escaped (default-safe)
    out = out.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
      const v = this.lookup(ctx, key);
      return v === undefined || v === null ? '' : this.escape(String(v));
    });

    return out;
  }

  private lookup(ctx: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = ctx;
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined;
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }

  private truthy(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.length > 0;
    if (typeof v === 'number') return v !== 0;
    if (Array.isArray(v)) return v.length > 0;
    return Boolean(v);
  }

  private escape(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
