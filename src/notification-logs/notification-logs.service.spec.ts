import { Test, TestingModule } from '@nestjs/testing';
import { NotificationLogsService } from './notification-logs.service';

describe('NotificationLogsService', () => {
  let service: NotificationLogsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationLogsService],
    }).compile();

    service = module.get<NotificationLogsService>(NotificationLogsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
