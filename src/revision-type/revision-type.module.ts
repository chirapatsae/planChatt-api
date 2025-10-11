import { Module } from '@nestjs/common';
import { RevisionTypeService } from './revision-type.service';
import { RevisionTypeController } from './revision-type.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RevisionType } from './entities/revision-type.entity';

@Module({
  imports: [TypeOrmModule.forFeature([RevisionType])],
  controllers: [RevisionTypeController],
  providers: [RevisionTypeService],
  exports: [RevisionTypeService],
})
export class RevisionTypeModule {}
