/**
 * CITIZEN_BADGES — the FROZEN civic-gamification badge catalog (W-P4).
 *
 * Each badge is a pure threshold over ONE computed engagement stat. Badges are
 * COMPUTED-ON-READ — there is NO persistence: `CitizenAchievementsService`
 * recomputes them on every request from the existing `citizen_*` counts.
 *
 * §17.2 ADVISORY — a badge gates NOTHING and awards NOTHING in the project
 * workflow; it is display-only recognition. §17.3 isolation — the stats are
 * read from `citizen_*` tables ONLY; this file introduces no entity / FK / write.
 *
 * `tier` drives the chip COLOUR only (bronze / silver / gold). `iconKey` is a
 * lucide-react icon name resolved at the FE. `metric` names the stat in
 * `CitizenStats` that the `threshold` is compared against (>=).
 */

/** The computed stats a badge threshold may key off of. */
export type CitizenBadgeMetric =
  | 'posts'
  | 'ideaPosts'
  | 'comments'
  | 'reactionsReceived'
  | 'pollVotes'
  | 'stories'
  | 'followers'
  | 'officialResponsesReceived';

export type CitizenBadgeTier = 'bronze' | 'silver' | 'gold';

export interface CitizenBadge {
  /** Stable key — never renamed (the FE maps copy/analytics off this). */
  key: string;
  labelTh: string;
  descriptionTh: string;
  /** lucide-react icon name. */
  iconKey: string;
  tier: CitizenBadgeTier;
  metric: CitizenBadgeMetric;
  /** Earned when `stats[metric] >= threshold`. */
  threshold: number;
}

/**
 * FROZEN catalog (9 badges). Order is the display order on the profile.
 */
export const CITIZEN_BADGES: readonly CitizenBadge[] = [
  {
    key: 'first_post',
    labelTh: 'ก้าวแรก',
    descriptionTh: 'โพสต์แรกในชุมชน',
    iconKey: 'Sprout',
    tier: 'bronze',
    metric: 'posts',
    threshold: 1,
  },
  {
    key: 'contributor',
    labelTh: 'ผู้มีส่วนร่วม',
    descriptionTh: 'โพสต์ครบ 10 รายการ',
    iconKey: 'PenLine',
    tier: 'silver',
    metric: 'posts',
    threshold: 10,
  },
  {
    key: 'community_voice',
    labelTh: 'เสียงของชุมชน',
    descriptionTh: 'ได้รับหัวใจรวม 100',
    iconKey: 'Heart',
    tier: 'gold',
    metric: 'reactionsReceived',
    threshold: 100,
  },
  {
    key: 'conversationalist',
    labelTh: 'นักสนทนา',
    descriptionTh: 'แสดงความคิดเห็น 50 ครั้ง',
    iconKey: 'MessageCircle',
    tier: 'silver',
    metric: 'comments',
    threshold: 50,
  },
  {
    key: 'civic_reporter',
    labelTh: 'พลเมืองตื่นรู้',
    descriptionTh: 'เสนอไอเดีย/ปัญหา 5 เรื่อง',
    iconKey: 'Megaphone',
    tier: 'silver',
    metric: 'ideaPosts',
    threshold: 5,
  },
  {
    key: 'pollster',
    labelTh: 'นักโหวต',
    descriptionTh: 'ร่วมโหวต 10 โพล',
    iconKey: 'BarChart3',
    tier: 'bronze',
    metric: 'pollVotes',
    threshold: 10,
  },
  {
    key: 'storyteller',
    labelTh: 'นักเล่าเรื่อง',
    descriptionTh: 'โพสต์สตอรี่ 5 รายการ',
    iconKey: 'BookOpen',
    tier: 'bronze',
    metric: 'stories',
    threshold: 5,
  },
  {
    key: 'connector',
    labelTh: 'นักเชื่อมโยง',
    descriptionTh: 'มีผู้ติดตาม 10 คน',
    iconKey: 'Users',
    tier: 'silver',
    metric: 'followers',
    threshold: 10,
  },
  {
    key: 'verified_civic',
    labelTh: 'ได้รับการตอบรับ',
    descriptionTh: 'มีโพสต์ที่หน่วยงานตอบกลับอย่างเป็นทางการ',
    iconKey: 'BadgeCheck',
    tier: 'gold',
    metric: 'officialResponsesReceived',
    threshold: 1,
  },
] as const;
