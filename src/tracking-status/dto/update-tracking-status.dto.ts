import { PartialType } from '@nestjs/mapped-types';
import { CreateTrackingStatusDto } from './create-tracking-status.dto';

export class UpdateTrackingStatusDto extends PartialType(CreateTrackingStatusDto) {}
