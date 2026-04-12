import {
  IsDate,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  IsOptional,
  IsDateString,
  IsBoolean,
  IsEnum,
} from 'class-validator';
import { ReportFormat } from '../types/report-format.enum';

export class CreateDevelopmentPlanDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsInt()
  @Min(2500)
  @Max(2600)
  startYear: number;

  @IsNotEmpty()
  @IsInt()
  @Min(2500)
  @Max(2600)
  endYear: number;

  @IsOptional()
  @IsBoolean()
  isBooked?: boolean;

  /**
   * CLAUDE.md §16.3 / §16.4 — multi-format reporting selector.
   *
   * Optional on the DTO (backend defaults to STRATEGY_BASED for
   * backward compatibility) but required by the frontend plan-create
   * form. Once the row is inserted the value is IMMUTABLE —
   * `UpdateDevelopmentPlanDto` must not include the field and the
   * service strips it defensively.
   */
  @IsOptional()
  @IsEnum(ReportFormat)
  reportFormat?: ReportFormat;
}

