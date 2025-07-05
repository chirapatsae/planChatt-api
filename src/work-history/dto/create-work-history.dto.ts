import { IsNotEmpty, IsOptional, IsBoolean, IsUUID } from 'class-validator';

export class CreateWorkHistoryDto {
  @IsNotEmpty()
  @IsUUID()
  userId: string; 

  @IsNotEmpty()
  amphoeId: string;

  @IsNotEmpty()
  localAdmistrativeOrganizationId: string;
  
}
