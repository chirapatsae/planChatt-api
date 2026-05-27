import { IsUUID } from 'class-validator';

export class IssueCredentialDto {
  @IsUUID()
  targetUserId: string;
}
