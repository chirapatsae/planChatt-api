import { Test, TestingModule } from '@nestjs/testing';
import { ExecutiveController } from './executive.controller';
import { ExecutiveService } from './executive.service';

describe('ExecutiveController', () => {
  let controller: ExecutiveController;

  beforeEach(async () => {
    // Mock ExecutiveService wholesale — this spec only asserts the
    // controller is defined, so there is no need to instantiate the real
    // service (which injects many @InjectRepository repos, incl. the
    // equipment repos added in wave-team-dashboard-equipment-coverage).
    // Providing the real class with no repo mocks fails DI at param 0.
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecutiveController],
      providers: [{ provide: ExecutiveService, useValue: {} }],
    }).compile();

    controller = module.get<ExecutiveController>(ExecutiveController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
