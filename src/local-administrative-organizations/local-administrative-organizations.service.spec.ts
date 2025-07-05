import { Test, TestingModule } from '@nestjs/testing';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';

describe('LocalAdministrativeOrganizationsService', () => {
  let service: LocalAdministrativeOrganizationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LocalAdministrativeOrganizationsService],
    }).compile();

    service = module.get<LocalAdministrativeOrganizationsService>(LocalAdministrativeOrganizationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
