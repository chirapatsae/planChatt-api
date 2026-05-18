import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sdg } from './entities/sdg.entity';
import { SdgService } from './sdg.service';
import { SdgController } from './sdg.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Sdg, WorkHistory])],
  controllers: [SdgController],
  providers: [SdgService],
  exports: [SdgService],
})
export class SdgModule {}
