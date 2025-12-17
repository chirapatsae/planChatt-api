import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class DeleteDevelopmentPlanDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'citizenIdSuffix must be a 6-digit number' })
  citizenIdSuffix: string;
}

