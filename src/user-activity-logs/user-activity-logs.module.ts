import { Module } from '@nestjs/common';
import { UserActivityLogsService } from './user-activity-logs.service';
import { UserActivityLogsController } from './user-activity-logs.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserActivityLog } from './entities/user-activity-log.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserActivityLog, User])],
  controllers: [UserActivityLogsController],
  providers: [UserActivityLogsService],
})
export class UserActivityLogsModule {}
