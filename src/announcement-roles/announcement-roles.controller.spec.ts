import { Test, TestingModule } from '@nestjs/testing';
import { AnnouncementRolesController } from './announcement-roles.controller';
import { AnnouncementRolesService } from './announcement-roles.service';

describe('AnnouncementRolesController', () => {
  let controller: AnnouncementRolesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnnouncementRolesController],
      providers: [AnnouncementRolesService],
    }).compile();

    controller = module.get<AnnouncementRolesController>(AnnouncementRolesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
