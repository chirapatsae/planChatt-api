/**
 * Public response shapes for the citizen NOTIFICATION surface (C3).
 *
 * PII guard: only the acting `displayAlias` is exposed — never the actor's
 * `nationalIdHash` / `thaidSubHash` / `*_enc`. D11/D16: a notification names
 * the acting alias but is NOT a queryable follower-of-me list.
 */
import { CitizenPostAuthorDto } from './citizen-post-response.dto';

export interface NotificationPostRefDto {
  id: string;
  title: string | null;
}

export interface NotificationDto {
  id: string;
  /** `comment` | `heart`. */
  kind: string;
  createdAt: string;
  read: boolean;
  actor: CitizenPostAuthorDto;
  post: NotificationPostRefDto | null;
}

export interface ListNotificationsResponseDto {
  items: NotificationDto[];
  nextCursor: { createdAt: string; id: string } | null;
}
