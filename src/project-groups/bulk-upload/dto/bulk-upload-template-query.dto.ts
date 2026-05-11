import { IsUUID } from 'class-validator';

/**
 * Query DTO for the W113-BE-TEMPLATE bulk-upload template endpoint.
 *
 * The only required parameter is the target `developmentPlanId` so the
 * server can resolve the plan's `reportFormat` (CLAUDE.md §16.3) and
 * render the matching column shape per §16.5.
 */
export class BulkUploadTemplateQueryDto {
  @IsUUID('4', { message: 'developmentPlanId ต้องเป็น UUID' })
  developmentPlanId: string;
}
