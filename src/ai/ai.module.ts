// src/ai/ai.module.ts
import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { SmartApproveReferenceService } from './smart-approve-reference.service';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { GeoBoundaryService } from './geo-boundary.service';

@Module({
  controllers: [AiController],
  providers: [
    AiService,
    SmartApproveReferenceService,
    GeoBoundaryService,
    SmartApprovePrecheckService,
  ],
})
export class AiModule {}
