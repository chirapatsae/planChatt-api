import { Test, TestingModule } from '@nestjs/testing';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';
import { CreateStatusDto } from './dto/create-status.dto';

describe('StatusController', () => {
  let controller: StatusController;
  let service: StatusService;

  const mockStatusService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    softRemove: jest.fn(),
    remove: jest.fn(),
    restore: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatusController],
      providers: [{ provide: StatusService, useValue: mockStatusService }],
    }).compile();

    controller = module.get<StatusController>(StatusController);
    service = module.get<StatusService>(StatusService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call service.create with dto and userId', () => {
      const dto: CreateStatusDto = { name: 'Test Status' };
      const req: any = { user: { userId: 'user-uuid' } };
      controller.create(dto, req);
      expect(service.create).toHaveBeenCalledWith(dto, 'user-uuid');
    });
  });
});
