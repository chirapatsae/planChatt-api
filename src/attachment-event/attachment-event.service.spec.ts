import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentEventService } from './attachment-event.service';

describe('AttachmentEventService', () => {
  let service: AttachmentEventService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AttachmentEventService],
    }).compile();

    service = module.get<AttachmentEventService>(AttachmentEventService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
