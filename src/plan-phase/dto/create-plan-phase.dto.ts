import { IsEnum, IsNotEmpty, IsOptional, IsUUID, IsDateString, IsBoolean } from 'class-validator';
import { PhaseType } from '../entities/plan-phase.entity';

export class CreatePlanPhaseDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

  @IsNotEmpty()
  @IsDateString()
  openDate: string;

  @IsNotEmpty()
  @IsDateString()
  closeDate: string;

  @IsNotEmpty()
  @IsEnum(PhaseType)
  phaseType: PhaseType;

  @IsOptional()
  @IsBoolean()
  isMerged?: boolean;

  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;
}