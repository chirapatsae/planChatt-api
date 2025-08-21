import { Test, TestingModule } from '@nestjs/testing';
import { WebsocketGateway } from './websocket.gateway';

describe('WebsocketGateway', () => {
  let gateway: WebsocketGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebsocketGateway],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('Role Room Management', () => {
    it('should handle join-role-room message', () => {
      const mockSocket = {
        id: 'test-socket-id',
        join: jest.fn(),
        emit: jest.fn(),
      } as any;

      const mockData = { roleName: 'admin' };

      gateway.handleJoinRoleRoom(mockSocket, mockData);

      expect(mockSocket.join).toHaveBeenCalledWith('role-admin');
      expect(mockSocket.emit).toHaveBeenCalledWith('joined-room', {
        message: 'Joined role room: admin',
        room: 'role-admin',
      });
    });

    it('should handle leave-role-room message', () => {
      const mockSocket = {
        id: 'test-socket-id',
        leave: jest.fn(),
      } as any;

      const mockData = { roleName: 'admin' };

      gateway.handleLeaveRoleRoom(mockSocket, mockData);

      expect(mockSocket.leave).toHaveBeenCalledWith('role-admin');
    });
  });

  describe('Broadcasting', () => {
    it('should broadcast announcement to role rooms', () => {
      const mockServer = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      } as any;

      gateway.server = mockServer;

      const roleNames = ['admin', 'user'];
      const announcement = { id: '1', title: 'Test' };

      gateway.broadcastAnnouncementToRoles(roleNames, announcement);

      expect(mockServer.to).toHaveBeenCalledWith('role-admin');
      expect(mockServer.to).toHaveBeenCalledWith('role-user');
      expect(mockServer.emit).toHaveBeenCalledTimes(2);
    });
  });
});
