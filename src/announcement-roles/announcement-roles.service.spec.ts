import { Test, TestingModule } from '@nestjs/testing';
import { AnnouncementRolesService } from './announcement-roles.service';

describe('AnnouncementRolesService', () => {
  let service: AnnouncementRolesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AnnouncementRolesService],
    }).compile();

    service = module.get<AnnouncementRolesService>(AnnouncementRolesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
