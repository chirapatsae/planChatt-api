import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Logger,
} from '@nestjs/common';
import { RevisionTypeService } from './revision-type.service';
import { CreateRevisionTypeDto } from './dto/create-revision-type.dto';
import { UpdateRevisionTypeDto } from './dto/update-revision-type.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({ path: 'revision-type', version: '1' })
@UseGuards(JwtAuthGuard)
export class RevisionTypeController {
  private readonly logger = new Logger(RevisionTypeController.name);

  constructor(private readonly revisionTypeService: RevisionTypeService) {}

  @Post()
  create(@Body() createRevisionTypeDto: CreateRevisionTypeDto) {
    this.logger.log('Creating revision type');
    return this.revisionTypeService.create(createRevisionTypeDto);
  }

  @Get()
  findAll() {
    this.logger.log('Fetching all revision types');
    return this.revisionTypeService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    this.logger.log(`Fetching revision type with id: ${id}`);
    return this.revisionTypeService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateRevisionTypeDto: UpdateRevisionTypeDto) {
    this.logger.log(`Updating revision type with id: ${id}`);
    return this.revisionTypeService.update(id, updateRevisionTypeDto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    this.logger.log(`Removing revision type with id: ${id}, mode: ${mode}`);
    return mode === 'soft'
      ? this.revisionTypeService.softRemove(id)
      : this.revisionTypeService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    this.logger.log(`Restoring revision type with id: ${id}`);
    return this.revisionTypeService.restore(id);
  }
}
