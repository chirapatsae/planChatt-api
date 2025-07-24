import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  ValidateNested,
} from 'class-validator';

export class GenerateProjectDto {
  @IsString()
  @IsNotEmpty()
  strategy: string;

  @IsString()
  @IsNotEmpty()
  tactic: string;

  @IsString()
  @IsNotEmpty()
  plan: string;

  @IsString()
  @IsOptional() // ระบุว่า field นี้ไม่จำเป็นต้องส่งมาก็ได้
  userPrompt?: string; // แก้ typo เป็น userPrompt
}

// DTO สำหรับข้อมูลโครงการปัจจุบัน (Nested DTO)
export class CurrentProjectDataDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  objective?: string;

  @IsString()
  @IsOptional()
  goal?: string;

  @IsString()
  @IsOptional()
  expected?: string;

  @IsString()
  @IsOptional()
  indicator?: string;
}

// DTO หลักสำหรับ Endpoint Regenerate
export class RegenerateFieldDto {
  @IsString()
  @IsNotEmpty()
  strategy: string;

  @IsString()
  @IsNotEmpty()
  tactic: string;

  @IsString()
  @IsNotEmpty()
  plan: string;

  @IsString()
  @IsOptional()
  initialPrompt?: string;

  @IsObject()
  @ValidateNested() // สั่งให้ NestJS ตรวจสอบข้อมูลใน Object นี้ด้วย
  @Type(() => CurrentProjectDataDto) // บอกให้ NestJS รู้ว่า Object นี้มีโครงสร้างแบบ CurrentProjectDataDto
  currentProjectData: CurrentProjectDataDto;

  @IsString()
  @IsNotEmpty()
  fieldToRegenerate: string;

  @IsString()
  @IsNotEmpty()
  modificationPrompt: string;
}
