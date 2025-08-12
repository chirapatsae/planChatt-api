import { Test, TestingModule } from '@nestjs/testing';
import { NotificationLogsController } from './notification-logs.controller';
import { NotificationLogsService } from './notification-logs.service';

describe('NotificationLogsController', () => {
  let controller: NotificationLogsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationLogsController],
      providers: [NotificationLogsService],
    }).compile();

    controller = module.get<NotificationLogsController>(NotificationLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
