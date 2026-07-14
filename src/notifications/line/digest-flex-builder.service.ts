import { Injectable, Logger } from '@nestjs/common';

import type { LineFlexMessage } from 'src/line/interfaces/line-message.interface';

/**
 * W105 BE-PR3 — Digest Flex builder.
 *
 * The single-project Flex renderer (`FlexTemplateRendererService`) walks a
 * static JSON tree and substitutes `{{key}}` placeholders. That walker is
 * intentionally dumb and does NOT understand arrays / repetition.
 *
 * The digest payload needs N repeated rows (one per project). Originally
 * we shipped a CAROUSEL (multiple horizontally-swipeable bubbles) but
 * users found it hard to scan — every project sat behind a swipe. The
 * builder now produces a SINGLE TALL BUBBLE with a vertical project list,
 * which reads top-to-bottom in one shot.
 *
 * Layout (single bubble):
 *   header wordmark (xxs gray, centered)
 *   title (lg bold black, centered) — "นำส่งโครงการ N รายการ"
 *   status icon (72px, centered)
 *   separator
 *   section label "รายการโครงการ" (xs gray bold)
 *   project list (vertical box):
 *     "1. {projectName}"  +  "{fromTh} → {toTh}"
 *     "2. ..."
 *     ...
 *     "และอีก K โครงการ"   ← only when N > MAX_VISIBLE_PROJECTS
 *   footer button "เปิดดูคิว ›"
 *
 * Visible-row cap — LINE Flex bubbles auto-size to content with a
 * generous max, but a 50-line list still feels overwhelming. We cap at
 * MAX_VISIBLE_PROJECTS rows; any overflow shows as a single trailing
 * "และอีก K โครงการ" line. The summary `totalCount` always reflects the
 * FULL count regardless of how many rows are visible.
 *
 * §17.2 advisory parity — the bubble carries a single read-only CTA.
 *   No inline workflow affordances.
 *
 * §17.3 audit separation — pure rendering; no DB / no queue / no
 *   tracking_status touch.
 *
 * §17.9 parity — user-controlled `projectName` is placed as a STRING
 *   PROPERTY on a JS object. The result is serialized by LINE SDK once,
 *   so a name containing `"` or `{{` is safe by construction.
 */

/** Per-project list row payload. */
export interface DigestProjectEntry {
  /** User-facing project name (truncated to MAX_PROJECT_NAME_CHARS). */
  projectName: string;
  /** Thai display label for the prior status (resolved via `status.th_name` per W67). */
  fromStatusTh: string;
  /** Thai display label for the new status (resolved via `status.th_name` per W67). */
  toStatusTh: string;
}

/** Inputs to the digest builder. */
export interface DigestFlexBuildInput {
  flavor: 'owner' | 'staff';
  /**
   * Total number of projects in the digest. The visible-row cap below is
   * separate — `totalCount` always shows the FULL count.
   */
  totalCount: number;
  /** Up to N projects; the builder caps the visible rows per `MAX_VISIBLE_PROJECTS`. */
  projects: DigestProjectEntry[];
  /**
   * Already-resolved icon base origin (no trailing slash). Caller resolves
   * via the same env priority as `FlexTemplateRendererService`:
   *   LINE_ICON_BASE_URL -> APP_URL -> ''.
   */
  iconBase: string;
  /** Deep-link to the queue / submitted page. */
  actionLink: string;
}

/** Maximum project rows shown in the bubble before overflow line. */
const MAX_VISIBLE_PROJECTS = 12;

/**
 * Maximum length applied to projectName before substitution. Mirrors
 * `FlexTemplateRendererService.MAX_PROJECT_NAME_CHARS`. Project names
 * exceeding the cap get a `…` suffix.
 */
const MAX_PROJECT_NAME_CHARS = 80;

/** Per-flavor resource bundle. Keeps the layout code symmetrical. */
const FLAVOR_RESOURCES = {
  owner: {
    title: (n: number) => `นำส่งโครงการ ${n} รายการ`,
    iconFile: 'project-submitted-owner.png',
    ctaLabel: 'เปิดดูคิว ›',
    altText: (n: number) => `[ยืนยันการนำส่ง] ส่งโครงการ ${n} รายการเรียบร้อย`,
    footerNote: 'ข้อความนี้เป็นการยืนยันการนำส่งเพื่อทราบเท่านั้น',
  },
  staff: {
    title: (n: number) => `มีโครงการใหม่รอตรวจสอบ ${n} รายการ`,
    iconFile: 'project-submitted.png',
    ctaLabel: 'ดูคิวตรวจสอบ ›',
    altText: (n: number) => `[แจ้งเตือน] มีโครงการใหม่รอการตรวจสอบ ${n} รายการ`,
    footerNote: 'ข้อความนี้ส่งถึงเจ้าหน้าที่ผู้รับผิดชอบในพื้นที่ของท่าน',
  },
} as const;

@Injectable()
export class DigestFlexBuilderService {
  private readonly logger = new Logger(DigestFlexBuilderService.name);

  /**
   * Build a `LineFlexMessage` with a single tall bubble that lists every
   * digested project vertically. Returns a Flex payload ready for
   * `LineMessagingService.pushMessage`.
   */
  buildSubmittedDigestFlex(input: DigestFlexBuildInput): LineFlexMessage {
    const { flavor, totalCount, projects, iconBase, actionLink } = input;
    const r = FLAVOR_RESOURCES[flavor];

    const visibleProjects = projects.slice(0, MAX_VISIBLE_PROJECTS);
    const overflowCount = Math.max(0, projects.length - MAX_VISIBLE_PROJECTS);

    const projectRows: object[] = visibleProjects.map((p, idx) => ({
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'text',
          text: `${idx + 1}. ${this.truncateProjectName(p.projectName)}`,
          size: 'sm',
          color: '#111827',
          wrap: true,
        },
        {
          type: 'text',
          text: `${p.fromStatusTh} → ${p.toStatusTh}`,
          size: 'xs',
          color: '#6B7280',
          wrap: false,
        },
      ],
    }));

    if (overflowCount > 0) {
      projectRows.push({
        type: 'text',
        text: `และอีก ${overflowCount} โครงการ`,
        size: 'xs',
        color: '#6B7280',
        align: 'center',
        margin: 'sm',
        wrap: false,
      });
    }

    const bubble = {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'ธนาคารโครงการ · เทศบาลตำบลหนองกระทุ่ม',
            size: 'xxs',
            color: '#6B7280',
            weight: 'regular',
            align: 'center',
            wrap: false,
          },
          {
            type: 'text',
            text: r.title(totalCount),
            size: 'lg',
            weight: 'bold',
            color: '#111827',
            wrap: true,
            align: 'center',
            margin: 'sm',
          },
          {
            type: 'image',
            url: `${iconBase}/line-icons/${r.iconFile}`,
            size: '72px',
            aspectMode: 'fit',
            aspectRatio: '1:1',
            align: 'center',
            margin: 'md',
          },
          {
            type: 'separator',
            color: '#E5E7EB',
            margin: 'md',
          },
          {
            type: 'text',
            text: 'รายการโครงการ',
            size: 'xs',
            color: '#6B7280',
            weight: 'bold',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            margin: 'sm',
            contents: projectRows,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        paddingTop: '0px',
        contents: [
          {
            type: 'button',
            style: 'link',
            color: '#4F46E5',
            height: 'sm',
            gravity: 'center',
            action: {
              type: 'uri',
              label: r.ctaLabel,
              uri: actionLink,
            },
          },
          {
            type: 'text',
            text: r.footerNote,
            size: 'xxs',
            color: '#9CA3AF',
            wrap: true,
            align: 'center',
          },
        ],
      },
    };

    return {
      type: 'flex',
      altText: r.altText(totalCount),
      contents: bubble,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private truncateProjectName(name: string): string {
    if (typeof name !== 'string') return '';
    if (name.length <= MAX_PROJECT_NAME_CHARS) return name;
    return name.slice(0, MAX_PROJECT_NAME_CHARS) + '…';
  }
}
