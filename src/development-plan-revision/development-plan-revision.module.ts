import { Module } from '@nestjs/common';
import { DevelopmentPlanRevisionService } from './development-plan-revision.service';
import { DevelopmentPlanRevisionController } from './development-plan-revision.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentPlanRevision } from './entities/development-plan-revision.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { UsersModule } from 'src/users/users.module';
import { PdfModule } from 'src/pdf/pdf.module';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlanRevision,
      DevelopmentPlan,
      RevisionType,
      WorkHistory,
      RevisedProjectGroup,
    ]),
    UsersModule,
    PdfModule,
    WebsocketModule,
    BookLockModule,
  ],
  controllers: [DevelopmentPlanRevisionController],
  providers: [DevelopmentPlanRevisionService],
  exports: [DevelopmentPlanRevisionService],
})
export class DevelopmentPlanRevisionModule {}
