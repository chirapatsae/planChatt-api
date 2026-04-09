import { BookAssemblySourceType } from '../enums/book-assembly.enums';

export enum BookDisplayStateEnum {
  NO_BOOK = 'no_book',
  DRAFT = 'draft',
  PUBLISHED_LATEST = 'published_latest',
  PUBLISHED_SUPERSEDED = 'published_superseded',
  LOCKED_BY_NEWER_REVISION = 'locked_by_newer_revision',
  FROZEN_HISTORICAL = 'frozen_historical',
}

export class BookDisplayStateDto {
  sourceType: BookAssemblySourceType;
  sourceId: string;

  /**
   * Denormalized cache value.
   * For MAIN_PLAN: reflects DevelopmentPlan.isFrozen (true when any revision exists).
   * For revision types: reflects DevelopmentPlanRevision.isOpen.
   */
  isFrozen: boolean;

  /**
   * True if no descendant COMPLETED version exists for any project in this book.
   * Meaning this version is still the effective leaf for all its projects.
   */
  isLeaf: boolean;

  state: BookDisplayStateEnum;

  /**
   * True if correct() would be blocked because a sibling revision has an active
   * draft (PREPARING or READY) that overlaps this book's project snapshot.
   */
  hasActiveDraftDependency: boolean;

  /**
   * Number of projects in the latest COMPLETED version snapshot whose
   * isCurrentLeaf = false (i.e. superseded by a newer book). 0 if no COMPLETED version.
   */
  blockedProjectCount: number;
}
