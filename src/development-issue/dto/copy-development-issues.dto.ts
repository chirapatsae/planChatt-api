import { IsNotEmpty, IsOptional, IsUUID, IsArray } from 'class-validator';

export class CopyDevelopmentIssuesDto {
  @IsUUID()
  @IsNotEmpty()
  targetPlanId: string;

  @IsUUID()
  @IsNotEmpty()
  sourcePlanId: string;

  /**
   * Optional list of specific issue IDs to copy.
   * If omitted or empty, ALL non-deleted issues from the source plan are copied.
   */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  issueIds?: string[];
}
