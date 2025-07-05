import { Module } from '@nestjs/common';
import { AmphoesService } from './amphoes.service';
import { AmphoesController } from './amphoes.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Amphoe } from './entities/amphoe.entity';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Amphoe , User , LocalAdministrativeOrganization])],
  controllers: [AmphoesController],
  providers: [AmphoesService],
})
export class AmphoesModule {}
