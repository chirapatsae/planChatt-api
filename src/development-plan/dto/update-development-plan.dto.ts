import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateDevelopmentPlanDto } from './create-development-plan.dto';

/**
 * CLAUDE.md §16.4 — `reportFormat` is IMMUTABLE after plan creation.
 *
 * We explicitly OMIT it from the update DTO shape so TypeScript / the
 * class-validator pipe both reject the field at the edge. The service
 * layer additionally enforces this defensively — see
 * `DevelopmentPlanService.update`, which throws
 * `REPORT_FORMAT_IMMUTABLE` if the payload still carries the field
 * (e.g. via a tampered request).
 */
export class UpdateDevelopmentPlanDto extends PartialType(
  OmitType(CreateDevelopmentPlanDto, ['reportFormat'] as const),
) {}
