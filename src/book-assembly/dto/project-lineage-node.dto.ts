import { BookProjectType } from '../enums/book-assembly.enums';

export class ProjectLineageNodeDto {
  projectId: string;
  projectType: BookProjectType;
  bookVersionId: string;
  parentBookVersionId: string | null;
  isCurrentLeaf: boolean;
  createdAt: Date;
}
