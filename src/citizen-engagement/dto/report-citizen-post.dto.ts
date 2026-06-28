import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of `POST /v1/citizen-engagement/posts/:id/report`. */
export class ReportCitizenPostDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
