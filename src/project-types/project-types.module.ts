import { Module } from '@nestjs/common';
import { ProjectTypesService } from './project-types.service';
import { ProjectTypesController } from './project-types.controller';
import { ProjectType } from './entities/project-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectType, WorkHistory])],
  controllers: [ProjectTypesController],
  providers: [ProjectTypesService],
})
export class ProjectTypesModule {}
