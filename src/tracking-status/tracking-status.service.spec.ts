import { Test, TestingModule } from '@nestjs/testing';
import { TrackingStatusService } from './tracking-status.service';

describe('TrackingStatusService', () => {
  let service: TrackingStatusService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackingStatusService],
    }).compile();

    service = module.get<TrackingStatusService>(TrackingStatusService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
