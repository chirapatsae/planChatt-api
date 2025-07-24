import { Module } from '@nestjs/common';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';
import { LocalAdministrativeOrganizationsController } from './local-administrative-organizations.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from './entities/local-administrative-organization.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([LocalAdministrativeOrganization, Amphoe, User]),
  ],
  controllers: [LocalAdministrativeOrganizationsController],
  providers: [LocalAdministrativeOrganizationsService],
})
export class LocalAdministrativeOrganizationsModule {}
