import { PartialType } from '@nestjs/mapped-types';
import { CreateAttachmentEventDto } from './create-attachment-event.dto';

export class UpdateAttachmentEventDto extends PartialType(CreateAttachmentEventDto) {} 