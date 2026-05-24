import { IsIn, IsUUID } from 'class-validator';

export class RecordViewDto {
  // `'supplement_project_group'` widened in Wave public-archive-
  // supplement BE-01. SPG-level view tracking only; supplement
  // BOOK-level view counter is deferred per BE-01 §6.6 (the plan-level
  // rollup is sufficient and supplement adds no separate book-level
  // view column).
  @IsIn([
    'project_group',
    'revised_project_group',
    'supplement_project_group',
    'development_plan',
  ])
  targetKind:
    | 'project_group'
    | 'revised_project_group'
    | 'supplement_project_group'
    | 'development_plan';

  @IsUUID()
  targetId: string;

  @IsUUID()
  deviceId: string;
}
