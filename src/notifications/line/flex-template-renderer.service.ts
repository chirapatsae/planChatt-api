import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import type { LineFlexMessage } from 'src/line/interfaces/line-message.interface';
import type { ProjectNotificationEventType } from '../events/project-notification-event';

/**
 * FlexTemplateNotFoundError — thrown when a Flex template file is missing
 * for the given event type. Treated as NON-RETRYABLE by the LINE
 * notification processor (parity with email's TemplateContextError).
 */
export class FlexTemplateNotFoundError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly searchedPath: string,
  ) {
    super(
      `[NotifyLine] flex-template-not-found: event=${eventType} path=${searchedPath}`,
    );
    this.name = 'FlexTemplateNotFoundError';
  }
}

/**
 * Render context — the placeholder values the Flex template consumes.
 * `reason` is optional and only meaningful for PROJECT_RETURNED_FOR_REVISION.
 */
export interface FlexRenderContext {
  projectName: string;
  fromStatusTh: string;
  toStatusTh: string;
  actionLink: string;
  reason?: string;
}

/**
 * Wave 96 — Flex template renderer for the 5 owner-facing LINE events.
 *
 * Design notes:
 *   - Templates are loaded from `templates/line/*.json` (one per event)
 *     and CACHED after first read (parity with `TemplateRendererService`
 *     hbs precompile). Cache key is the resolved file path.
 *   - Substitution walks the parsed JSON tree and replaces `{{…}}`
 *     placeholders inside string leaves only. This is preferred over
 *     raw string concatenation because the parsed tree handles nested
 *     escaping correctly — a project name containing a `"` cannot
 *     break the bubble JSON structure (W96-TEMPLATES §7).
 *   - The renderer is intentionally NOT registered with any module here.
 *     Wiring is owned by W96-DISPATCH; this file ships the helper only.
 *
 * §17.2 advisory — every rendered bubble carries a single read-only CTA
 * ("เปิดดูโครงการ"). No inline workflow affordances.
 *
 * §17.9 parity — user-controlled text (projectName, reason) is interpolated
 * via tree-walk substitution, NEVER concatenated raw into JSON.
 *
 * W83 — log lines do NOT include rendered text or project names.
 */
@Injectable()
export class FlexTemplateRendererService {
  private readonly logger = new Logger(FlexTemplateRendererService.name);
  private readonly templateDir: string;
  private readonly cache = new Map<string, object>();

  /**
   * Maximum length applied to the projectName placeholder before it is
   * substituted into the bubble (W96-TEMPLATES §11 — long Thai names
   * overflow Flex bubbles on small mobile screens). 80 chars + ellipsis
   * keeps the bubble visually balanced; Flex `wrap: true` handles wrap
   * within that budget.
   */
  private static readonly MAX_PROJECT_NAME_CHARS = 80;

  /**
   * Mapping from event type to template file basename. The closed list
   * mirrors `LINE_EVENT_ALLOWLIST` from project-notification-event.ts —
   * adding a new entry there REQUIRES a corresponding template file and
   * an entry in this map.
   */
  private static readonly TEMPLATE_MAP: Record<
    ProjectNotificationEventType,
    string | null
  > = {
    PROJECT_SUBMITTED_OWNER: 'project-submitted-owner',
    PROJECT_VERIFIED_OWNER: 'project-verified-owner',
    PROJECT_RETURNED_FOR_REVISION: 'project-returned-for-revision',
    PROJECT_APPROVED: 'project-approved',
    PROJECT_REJECTED_OWNER: 'project-rejected-owner',
    // W96F — staff-side LINE awareness templates.
    PROJECT_SUBMITTED: 'project-submitted',
    PROJECT_PULLED_BACK: 'project-pulled-back',
    // EMAIL_VERIFICATION_REQUEST is email-only and intentionally not in
    // LINE_EVENT_ALLOWLIST. Mapped to null so an accidental render call
    // surfaces as a clean FlexTemplateNotFoundError rather than silently
    // emitting an empty bubble.
    EMAIL_VERIFICATION_REQUEST: null,
    // W105 BE-PR2 — digest events bypass this renderer entirely (the static
    // walker does not understand carousel repetition). They are routed
    // through `DigestFlexBuilderService` inside `NotificationsLineService.
    // sendPreparedJob`. Mapped to null so a defensive call here surfaces
    // a clean FlexTemplateNotFoundError instead of silently rendering an
    // empty bubble.
    PROJECT_SUBMITTED_DIGEST: null,
    PROJECT_SUBMITTED_OWNER_DIGEST: null,
  };

  /**
   * altText (LINE plain-text fallback shown in chat-list previews and on
   * older clients without Flex support). Patterns intentionally mirror
   * `SUBJECT_MAP` in `notifications-email.service.ts` so the user sees
   * consistent wording across email and LINE.
   */
  private static readonly ALT_TEXT_MAP: Record<
    ProjectNotificationEventType,
    ((projectName: string) => string) | null
  > = {
    PROJECT_SUBMITTED_OWNER: (p) =>
      `[ยืนยันการนำส่ง] โครงการของท่านถูกส่งเรียบร้อย: ${p}`,
    PROJECT_VERIFIED_OWNER: (p) =>
      `[แจ้งความคืบหน้า] โครงการของท่านผ่านการตรวจสอบ: ${p}`,
    PROJECT_RETURNED_FOR_REVISION: (p) =>
      `[แจ้งเตือน] โครงการของท่านถูกส่งกลับเพื่อแก้ไข: ${p}`,
    PROJECT_APPROVED: (p) =>
      `[แจ้งเตือน] โครงการของท่านได้รับการอนุมัติ: ${p}`,
    PROJECT_REJECTED_OWNER: (p) =>
      `[แจ้งผล] โครงการของท่านไม่ผ่านการพิจารณา (เกินศักยภาพ): ${p}`,
    // W96F — staff-side altText. Wording mirrors the email SUBJECT_MAP for
    // the same events so staff see a consistent message across channels.
    PROJECT_SUBMITTED: (p) =>
      `[แจ้งเตือน] มีโครงการใหม่รอการตรวจสอบ: ${p}`,
    PROJECT_PULLED_BACK: (p) =>
      `[แจ้งเตือน] โครงการถูกถอนออกจากการตรวจสอบ: ${p}`,
    EMAIL_VERIFICATION_REQUEST: null,
    // W105 BE-PR2 — digest events use the carousel builder's own altText
    // (computed from `totalCount`); the renderer-side altText is not used
    // for digest jobs. Mapped to null for typing exhaustiveness only.
    PROJECT_SUBMITTED_DIGEST: null,
    PROJECT_SUBMITTED_OWNER_DIGEST: null,
  };

  constructor() {
    this.templateDir = FlexTemplateRendererService.resolveTemplateDir();
    this.logger.log(
      `[NotifyLine] flex template directory resolved: ${this.templateDir}`,
    );
  }

  /**
   * Render a Flex Message for the given event type. Returns a fully-rendered
   * `LineFlexMessage` ready to pass to `LineMessagingService.pushMessage`.
   *
   * Throws `FlexTemplateNotFoundError` for events not in the LINE allowlist
   * or when the template file is missing on disk.
   */
  renderFlexTemplate(
    eventType: ProjectNotificationEventType,
    ctx: FlexRenderContext,
  ): LineFlexMessage {
    const templateName = FlexTemplateRendererService.TEMPLATE_MAP[eventType];
    if (!templateName) {
      throw new FlexTemplateNotFoundError(eventType, '<not-line-eligible>');
    }

    const altTextBuilder = FlexTemplateRendererService.ALT_TEXT_MAP[eventType];
    if (!altTextBuilder) {
      // Defensive — TEMPLATE_MAP and ALT_TEXT_MAP must stay in sync.
      throw new FlexTemplateNotFoundError(eventType, '<alt-text-missing>');
    }

    const template = this.loadTemplate(templateName);
    const projectName = this.truncateProjectName(ctx.projectName);

    // Substitute placeholders by walking the parsed JSON tree. Strings
    // are replaced in-place; arrays/objects are walked recursively. This
    // approach makes user-controlled text safe by construction — the
    // `\"` in a project name becomes a normal character inside an
    // already-parsed string, never a JSON quote.
    //
    // `iconBase` is the public origin where the backend serves
    // `/line-icons/*.png` (mounted via `app.useStaticAssets` in main.ts).
    // Resolution order: LINE_ICON_BASE_URL (explicit override, useful for
    // dev tunnels like ngrok) → APP_URL (production canonical origin) →
    // empty string (renders broken image, surfaces misconfig loudly).
    const iconBase = (
      process.env.LINE_ICON_BASE_URL ||
      process.env.APP_URL ||
      ''
    ).replace(/\/$/, '');
    const substitutions: Record<string, string> = {
      projectName,
      fromStatusTh: ctx.fromStatusTh,
      toStatusTh: ctx.toStatusTh,
      actionLink: ctx.actionLink,
      reason: ctx.reason ?? '',
      iconBase,
    };
    const contents = this.substitute(template, substitutions) as object;

    return {
      type: 'flex',
      altText: altTextBuilder(projectName),
      contents,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Resolution order — mirror `TemplateRendererService.resolveTemplateDir`:
   *   1. Sibling of compiled __dirname canonical
   *      (`dist/src/notifications/templates/line/`)
   *   2. Source-tree fallback (walk up to `src/notifications/templates/line/`)
   *      so `nest start` without asset copy still works.
   *
   * Last-resort fallback returns the canonical sibling so the original
   * file-not-found error surfaces in logs.
   */
  private static resolveTemplateDir(): string {
    const candidates: string[] = [];

    // Candidate 1 — compiled sibling.
    candidates.push(path.join(__dirname, '..', 'templates', 'line'));

    // Candidate 2 — walk up to find the source-tree templates dir.
    let current = __dirname;
    for (let i = 0; i < 8; i++) {
      const parent = path.dirname(current);
      if (parent === current) break;
      const sourceCandidate = path.join(
        parent,
        'src',
        'notifications',
        'templates',
        'line',
      );
      if (
        fs.existsSync(
          path.join(sourceCandidate, 'project-submitted-owner.json'),
        )
      ) {
        candidates.push(sourceCandidate);
        break;
      }
      current = parent;
    }

    for (const dir of candidates) {
      if (
        fs.existsSync(path.join(dir, 'project-submitted-owner.json'))
      ) {
        return dir;
      }
    }
    return candidates[0];
  }

  private loadTemplate(templateName: string): object {
    const filePath = path.join(this.templateDir, `${templateName}.json`);
    const cached = this.cache.get(filePath);
    if (cached) return cached;

    if (!fs.existsSync(filePath)) {
      throw new FlexTemplateNotFoundError(templateName, filePath);
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(source) as object;
    this.cache.set(filePath, parsed);
    return parsed;
  }

  /**
   * Walk the parsed JSON tree and replace `{{key}}` placeholders inside
   * string leaves. Returns a deeply-cloned tree so the cached template
   * is never mutated.
   *
   * Behavior on missing keys: an unrecognised `{{foo}}` is left as-is in
   * the output. This is defensive — a typo in a template should be loud
   * (visible in the rendered bubble) rather than silently swallowed.
   */
  private substitute(node: unknown, vars: Record<string, string>): unknown {
    if (typeof node === 'string') {
      return node.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key)
          ? vars[key]
          : match;
      });
    }
    if (Array.isArray(node)) {
      return node.map((item) => this.substitute(item, vars));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = this.substitute(v, vars);
      }
      return out;
    }
    return node;
  }

  private truncateProjectName(name: string): string {
    if (typeof name !== 'string') return '';
    if (name.length <= FlexTemplateRendererService.MAX_PROJECT_NAME_CHARS) {
      return name;
    }
    return (
      name.slice(0, FlexTemplateRendererService.MAX_PROJECT_NAME_CHARS) + '…'
    );
  }
}
