import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, WorkHistory, Status, TrackingStatus]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
