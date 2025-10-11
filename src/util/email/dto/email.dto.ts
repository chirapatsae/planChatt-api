
import { IsArray, IsString, IsOptional, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { EmailType } from '../email-notification.service';

export class ProjectListData {
  @IsString()
  title: string;

  @IsString()
  createdBy: string;
}

export class SendProjectListEmailDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProjectListData)
  listData: ProjectListData[];

  @IsOptional()
  @IsString()
  customSubject?: string;

  @IsString()
  @IsIn(['SendToVerify', 'SentToEdit', 'Custom'])
  type: EmailType;

  @IsOptional()
  @IsString()
  reviewerName?: string;
}

export interface EmailTemplateData {
  projectList?: ProjectListData;
  customData?: any;
}