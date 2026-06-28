import { PostDto } from './citizen-post-response.dto';

/**
 * Response shapes for the OWNER-scoped citizen profile surface (C1).
 *
 * PII guard (§17.3): these objects carry ONLY `displayAlias` from the identity
 * row — never `nationalIdHash` / `thaidSubHash` / `*_enc`. The service builds
 * them by hand, so the encrypted identity columns can never leak.
 */
export interface MyProfileDto {
  id: string;
  displayAlias: string;
  joinedAt: string;
  postCount: number;
  heartsReceived: number;
}

/**
 * The owner view of one of their own posts — the public `PostDto` shape PLUS
 * `moderationState`, so the owner can see whether their post is visible,
 * pending review, hidden, etc.
 */
export interface MyPostDto extends PostDto {
  moderationState: string;
}

export interface MyPostsResponseDto {
  items: MyPostDto[];
  nextCursor: { createdAt: string; id: string } | null;
}
