import { Module } from '@nestjs/common';
import { PositionsService } from './positions.service';
import { PositionsController } from './positions.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Position } from './entities/position.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Position, User])],
  controllers: [PositionsController],
  providers: [PositionsService],
})
export class PositionsModule {}
