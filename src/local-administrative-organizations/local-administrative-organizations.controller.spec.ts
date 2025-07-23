import { Test, TestingModule } from '@nestjs/testing';
import { LocalAdministrativeOrganizationsController } from './local-administrative-organizations.controller';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LocalAdministrativeOrganization } from './entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';

describe('LocalAdministrativeOrganizationsController', () => {
  let controller: LocalAdministrativeOrganizationsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocalAdministrativeOrganizationsController],
      providers: [
        LocalAdministrativeOrganizationsService,
        {
          provide: getRepositoryToken(LocalAdministrativeOrganization),
          useValue: {},
        },
        {
          provide: getRepositoryToken(Amphoe),
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<LocalAdministrativeOrganizationsController>(LocalAdministrativeOrganizationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
