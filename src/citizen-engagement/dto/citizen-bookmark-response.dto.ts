import { PostDto } from './citizen-post-response.dto';

/**
 * Response of `GET /v1/citizen-engagement/me/bookmarks` (W-S3).
 *
 * `items` REUSES the feed's `PostDto` shape verbatim (same author + media). The
 * cursor differs: the saved list paginates by the BOOKMARK's (createdAt, id)
 * DESC — newest-save first — so the cursor carries `createdAt` (ISO string),
 * NOT the feed's `rankScore`.
 */
export interface ListCitizenBookmarksResponseDto {
  items: PostDto[];
  nextCursor: { createdAt: string; id: string } | null;
}
