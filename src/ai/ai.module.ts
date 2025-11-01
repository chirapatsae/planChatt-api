// src/ai/ai.module.ts
import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ProjectGroupsModule } from '../project-groups/project-groups.module';

@Module({
  imports: [ProjectGroupsModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
