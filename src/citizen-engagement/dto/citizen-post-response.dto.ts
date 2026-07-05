/**
 * Public response shapes for the citizen-engagement board.
 *
 * PII guard: these mappers NEVER expose `nationalIdHash` / `thaidSubHash` /
 * `*_enc` — only `author.displayAlias` (the single public name). All write
 * paths flow through `CitizenPostService` which builds these objects by hand,
 * so the encrypted identity columns can never leak.
 */
import { CitizenReactionType } from '../constants/citizen-reactions';
import { CitizenMentionDto } from './citizen-mention-response.dto';
import { OfficialResponseDto } from './citizen-official-response.dto';

export interface CitizenPostAuthorDto {
  /**
   * W-GATE-1: the author's identity UUID — an OPAQUE handle needed to offer a
   * follow button and link to the public profile (`/community/u/:id`). A UUID
   * is NOT PII; the `*_enc` / `*_hash` / national-id columns stay unexposed.
   */
  id: string;
  displayAlias: string;
  /**
   * Axios-relative profile-photo URL (cache-busted), or null when the author
   * has no uploaded photo (FE falls back to the gradient+initial). §17.3 — the
   * served endpoint is public and exposes only the opaque identity id, never a
   * disk path. Optional so author constructors that don't resolve it (chat /
   * bookmark / poll) stay source-compatible.
   */
  avatarUrl?: string | null;
}

export interface CitizenPostMediaDto {
  id: string;
  url: string;
}

/**
 * W-S2: the embedded ORIGINAL shown inside a repost card. A trimmed `PostDto`
 * (no nested `repostOf` — flatten-to-root guarantees the original is never
 * itself a repost) carrying alias + media so the FE renders the quoted post
 * inline with ONE batch query (no N+1).
 */
export interface RepostEmbedDto {
  id: string;
  postKind: string;
  lat: number | null;
  lng: number | null;
  amphoeId: string | null;
  category: string | null;
  title: string | null;
  detail: string | null;
  heartCount: number;
  reactionCount: number;
  commentCount: number;
  repostCount: number;
  createdAt: string;
  author: CitizenPostAuthorDto;
  media: CitizenPostMediaDto[];
}

/**
 * W-S2: tombstone shown in place of a repost embed when the ORIGINAL is now
 * hidden / removed / soft-deleted. NEVER leaks the original's content (§17.3 —
 * hidden/removed originals must not leak).
 */
export interface RepostTombstoneDto {
  unavailable: true;
}

/**
 * W-S7: one poll option in a result-bar. `voteCount` is the AGGREGATE live tally
 * for the option (D16 — only counts are public; WHO voted is never exposed).
 */
export interface PollOptionDto {
  id: string;
  label: string;
  voteCount: number;
}

/**
 * W-S7: the poll attached to a `post_kind = 'poll'` post. Batch-loaded with the
 * post (options + counts in ONE query — no N+1). D16: only aggregate counts are
 * exposed here; the caller's OWN vote (`myOptionId`) is delivered separately via
 * the owner-scoped `GET me/poll-votes` (never inside this public shape).
 */
export interface PollDto {
  options: PollOptionDto[];
  /** Sum of all options' `voteCount`. */
  totalVotes: number;
  /** ISO-8601 close time, or null = never closes. */
  closesAt: string | null;
  /** `true` when `closesAt` is non-null AND in the past (poll is read-only). */
  closed: boolean;
}

export interface PostDto {
  id: string;
  postKind: string;
  lat: number | null;
  lng: number | null;
  amphoeId: string | null;
  category: string | null;
  title: string | null;
  detail: string | null;
  /**
   * W-S1: total live reactions of ANY type (the engagement signal that drives
   * `rankScore`). `heartCount` is an ALIAS of `reactionCount` for back-compat.
   */
  heartCount: number;
  /** W-S1: total live reactions of ANY type (= `heartCount`). */
  reactionCount: number;
  /** W-S1: live count per reaction key — every key present (zero-filled). */
  reactionBreakdown: Record<CitizenReactionType, number>;
  commentCount: number;
  /** W-S2: denormalized share count (this row's, if it is itself a root). */
  repostCount: number;
  createdAt: string;
  author: CitizenPostAuthorDto;
  media: CitizenPostMediaDto[];
  /**
   * W-S2: when THIS post is a repost (`repostOfId` set), the embedded original —
   * batch-loaded with author + media. A `RepostTombstoneDto` (`{ unavailable:
   * true }`) when the original is hidden / removed / deleted (never leaks it).
   * `undefined` when this post is not a repost.
   */
  repostOf?: RepostEmbedDto | RepostTombstoneDto;
  /**
   * W-S7: present ONLY when `postKind = 'poll'` — the options + aggregate vote
   * counts + close state, batch-loaded with the post. D16: NEVER carries
   * who-voted-what; the caller's own vote arrives via `GET me/poll-votes`.
   * `undefined` when this post is not a poll.
   */
  poll?: PollDto;
  /**
   * W-S6: the citizens @mentioned in this post body — `{ identityId,
   * displayAlias }` (alias-only, resolved at create time) so the FE can linkify
   * `@alias` occurrences to `/community/u/:identityId`. Omitted / `[]` when the
   * post mentions no one.
   */
  mentions?: CitizenMentionDto[];
  /**
   * Owner-controlled "hide" state (ซ่อนให้เห็นเฉพาะฉัน). When `true` the post is
   * excluded from every PUBLIC read and appears ONLY to its author — so this
   * flag is `true` only on the owner's own view of their hidden post; other
   * viewers never receive a hidden post at all. The FE shows a "เห็นเฉพาะคุณ"
   * badge + an unhide action when this is `true`. §17.2 advisory — hiding
   * changes no workflow and no project data.
   */
  ownerHidden?: boolean;
}

export interface CommentDto {
  id: string;
  text: string;
  createdAt: string;
  author: CitizenPostAuthorDto;
  /** Reply threading (1 level): null = top-level comment; else the parent
   *  comment id it replies to. */
  parentId: string | null;
  /** Live LIKE (heart) count on this comment. */
  heartCount: number;
  /**
   * W-S6: the citizens @mentioned in this comment body — `{ identityId,
   * displayAlias }` (alias-only). Omitted / `[]` when the comment mentions no one.
   */
  mentions?: CitizenMentionDto[];
}

export interface PostDetailDto extends PostDto {
  comments: CommentDto[];
  // C4 (plan D12): official staff responses on this post, oldest-first. Only
  // included on the DETAIL read — the feed `list()` never carries them.
  officialResponses: OfficialResponseDto[];
}

export interface ListCitizenPostsResponseDto {
  items: PostDto[];
  // W-F2: the ranked feed paginates by (rankScore, id) DESC, so the cursor
  // carries the last row's rankScore (not createdAt). The map/profile/
  // notification reads keep their own createdAt-based cursors.
  nextCursor: { rankScore: number; id: string } | null;
}
