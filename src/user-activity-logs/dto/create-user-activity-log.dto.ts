import { IsString, IsNotEmpty } from 'class-validator';

export class CreateUserActivityLogDto {
  @IsString()
  @IsNotEmpty()
  activityType: string;

  @IsString()
  @IsNotEmpty()
  activityDetail: string;

  @IsString()
  @IsNotEmpty()
  ipAddress: string;

  @IsString()
  @IsNotEmpty()
  platform: string;

  @IsString()
  @IsNotEmpty()
  userAgent: string;
}
