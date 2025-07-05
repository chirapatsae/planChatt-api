import { Test, TestingModule } from '@nestjs/testing';
import { TrackingStatusController } from './tracking-status.controller';
import { TrackingStatusService } from './tracking-status.service';

describe('TrackingStatusController', () => {
  let controller: TrackingStatusController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrackingStatusController],
      providers: [TrackingStatusService],
    }).compile();

    controller = module.get<TrackingStatusController>(TrackingStatusController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
