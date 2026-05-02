import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from 'src/users/users.module';

// W89B — `TypeOrmModule.forFeature([WorkHistory, User])` was removed: the
// AuthService no longer injects either repository (W89-BE-AUTH-INTEGRATION
// routed all User reads/writes through UsersService, and WorkHistory was
// already unused). UsersModule is the only remaining dependency.
@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || '',
      signOptions: { expiresIn: '1d' },
    }),
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule { }
