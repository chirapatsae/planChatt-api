import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { UsersService } from 'src/users/users.service';
import * as dotenv from 'dotenv';
dotenv.config();

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || '',
      signOptions: { expiresIn: '1d' },
    }),
    TypeOrmModule.forFeature([WorkHistory, User]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, UsersService],
})
export class AuthModule {}
