import { PartialType } from '@nestjs/mapped-types';
import { CreateUserActivityLogDto } from './create-user-activity-log.dto';

export class UpdateUserActivityLogDto extends PartialType(CreateUserActivityLogDto) {}
