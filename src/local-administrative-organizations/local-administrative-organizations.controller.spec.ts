import { Test, TestingModule } from '@nestjs/testing';
import { LocalAdministrativeOrganizationsController } from './local-administrative-organizations.controller';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';

describe('LocalAdministrativeOrganizationsController', () => {
  let controller: LocalAdministrativeOrganizationsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocalAdministrativeOrganizationsController],
      providers: [LocalAdministrativeOrganizationsService],
    }).compile();

    controller = module.get<LocalAdministrativeOrganizationsController>(LocalAdministrativeOrganizationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
