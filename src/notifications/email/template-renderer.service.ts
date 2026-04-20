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
  private readonly compiled = new Map<string, (ctx: Record<string, unknown>) => string>();
  private readonly partials = new Map<string, string>();

  constructor() {
    this.templateDir = path.join(__dirname, '..', 'templates');
    this.loadPartials();
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
  render(templateName: string, context: Record<string, unknown>, requiredFields: string[] = []): string {
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
        throw new TemplateContextError(templateName, [`<file-not-found:${filePath}>`]);
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
    const expanded = source.replace(/\{\{>\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, name: string) => {
      const partial = this.partials.get(name);
      if (!partial) {
        this.logger.warn(`[Notify] partial-missing: ${name}`);
        return '';
      }
      return partial;
    });

    return (ctx: Record<string, unknown>) => this.evaluate(expanded, ctx);
  }

  private evaluate(template: string, ctx: Record<string, unknown>): string {
    // {{#if var}}...{{/if}} (non-nested, single-line or multi-line)
    let out = template.replace(
      /\{\{#if\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_m, key: string, body: string) => (this.truthy(this.lookup(ctx, key)) ? body : ''),
    );

    // {{{raw}}} — no escape
    out = out.replace(/\{\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\}/g, (_m, key: string) => {
      const v = this.lookup(ctx, key);
      return v === undefined || v === null ? '' : String(v);
    });

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
