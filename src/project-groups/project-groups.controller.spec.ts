import { Test, TestingModule } from '@nestjs/testing';
import { ProjectGroupsController } from './project-groups.controller';
import { ProjectGroupsService } from './project-groups.service';

describe('ProjectGroupsController', () => {
  let controller: ProjectGroupsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectGroupsController],
      providers: [ProjectGroupsService],
    }).compile();

    controller = module.get<ProjectGroupsController>(ProjectGroupsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
