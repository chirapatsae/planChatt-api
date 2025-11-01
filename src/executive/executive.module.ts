import { Module } from '@nestjs/common';
import { ExecutiveService } from './executive.service';
import { ExecutiveController } from './executive.controller';

@Module({
  controllers: [ExecutiveController],
  providers: [ExecutiveService],
})
export class ExecutiveModule {}
