import { Module } from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
import { WorkHistoryController } from './work-history.controller';
import { WorkHistory } from './entities/work-history.entity';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkHistory, WorkHistoryAmphoeResponsibility, User, LocalAdministrativeOrganization, Amphoe])],
  controllers: [WorkHistoryController],
  providers: [WorkHistoryService],
  exports: [WorkHistoryService],
})
export class WorkHistoryModule { }
