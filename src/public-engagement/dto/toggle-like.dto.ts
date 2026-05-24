import { IsIn, IsUUID } from 'class-validator';

export class ToggleLikeDto {
  // `'supplement_project_group'` widened in Wave public-archive-
  // supplement BE-01. The discriminator column is `varchar(32)` with
  // NO FK (§17.3) so the DB accepts the new literal without migration.
  @IsIn(['project_group', 'revised_project_group', 'supplement_project_group'])
  targetKind:
    | 'project_group'
    | 'revised_project_group'
    | 'supplement_project_group';

  @IsUUID()
  targetId: string;

  @IsUUID()
  deviceId: string;
}
