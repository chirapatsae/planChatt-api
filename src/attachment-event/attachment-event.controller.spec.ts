import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentEventController } from './attachment-event.controller';

describe('AttachmentEventController', () => {
  let controller: AttachmentEventController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttachmentEventController],
    }).compile();

    controller = module.get<AttachmentEventController>(AttachmentEventController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
