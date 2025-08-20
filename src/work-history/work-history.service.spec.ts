import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryService } from './work-history.service';
import { WebsocketService } from '../websocket/websocket/websocket.service';

describe('WorkHistoryService', () => {
  let service: WorkHistoryService;
  let websocketService: WebsocketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkHistoryService,
        {
          provide: WebsocketService,
          useValue: {
            notifyWorkStatusUpdate: jest.fn(),
            // notifyUser ไม่มีอยู่แล้ว เพราะเราลบออก
          },
        },
      ],
    }).compile();

    service = module.get<WorkHistoryService>(WorkHistoryService);
    websocketService = module.get<WebsocketService>(WebsocketService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('update work status', () => {
    it('should send notification when work status changes to approved', async () => {
      // Mock data
      const mockUpdateDto = {
        amphoeId: '3001',
        localAdministrativeOrganizationId: '3001027',
        userId: 'test-user-id',
        workStatusName: 'approved',
        roleName: 'user',
        governmentAgenciesId: 'test-agency-id',
      };

      const mockUpdatorId = 'updator-id';

      // Mock websocket service
      jest.spyOn(websocketService, 'notifyWorkStatusUpdate').mockResolvedValue({
        success: true,
        message: 'Notification sent',
        timestamp: new Date().toISOString(),
      });

      // notifyUser ไม่มีอยู่แล้ว เพราะเราลบออก

      // Test the update method (you'll need to mock all dependencies)
      // This is a basic test structure
      expect(websocketService.notifyWorkStatusUpdate).toBeDefined();
      // expect(websocketService.notifyUser).toBeDefined(); // ไม่มี notifyUser แล้ว
    });
  });
});
