import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:5173', 'https://9094fafecec2.ngrok-free.app'],
    credentials: true,
  },
  namespace: '/api/v1/notifications',
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);
  private connectedClients = new Map<string, { userId: string; socket: Socket }>();

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Remove client from connected clients
    for (const [key, value] of this.connectedClients.entries()) {
      if (value.socket.id === client.id) {
        this.connectedClients.delete(key);
        break;
      }
    }
  }

  @SubscribeMessage('join-user-room')
  handleJoinUserRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string },
  ) {
    const { userId } = data;
    
    // Join user-specific room
    client.join(`user-${userId}`);
    
    // Store client connection with userId
    this.connectedClients.set(client.id, { userId, socket: client });
    
    this.logger.log(`User ${userId} joined room: user-${userId}`);
    
    // Send confirmation
    client.emit('joined-room', { 
      message: `Joined room for user ${userId}`,
      room: `user-${userId}`
    });
  }
  @SubscribeMessage('leave-user-room')
  handleLeaveUserRoom(@ConnectedSocket() client: Socket) {
    // Remove client from connected clients
    for (const [key, value] of this.connectedClients.entries()) {
      if (value.socket.id === client.id) {
        this.connectedClients.delete(key);
        break;
      }
    }
    
    this.logger.log(`Client ${client.id} left user room`);
  }

  // Method to notify specific user about work status update
  notifyWorkStatusUpdate(userId: string, workStatus: string, workHistoryId: string, role?: string, previousRole?: string, previousWorkStatus?: string, updatedBy?: string) {
    this.server.to(`user-${userId}`).emit('work-status-updated', {
      userId,  // ← เพิ่ม userId
      workStatus,
      workHistoryId,
      role,
      previousRole,      // ← เพิ่ม previousRole
      previousWorkStatus, // ← เพิ่ม previousWorkStatus
      updatedBy,         // ← เพิ่ม updatedBy
      timestamp: new Date().toISOString(),
      message: `Your work status has been updated to: ${workStatus}`,
    });
    
    this.logger.log(`Notified user ${userId} about work status update: ${workStatus}, role: ${role}, previousRole: ${previousRole}, previousWorkStatus: ${previousWorkStatus}`);
  }


  // Get connected clients info for debugging
  getConnectedClients() {
    return Array.from(this.connectedClients.entries()).map(([socketId, { userId }]) => ({
      socketId,
      userId,
    }));
  }

  // Check if user is connected
  isUserConnected(userId: string): boolean {
    for (const [, value] of this.connectedClients.entries()) {
      if (value.userId === userId) {
        return true;
      }
    }
    return false;
  }

  // Get user's socket
  getUserSocket(userId: string): Socket | null {
    for (const [, value] of this.connectedClients.entries()) {
      if (value.userId === userId) {
        return value.socket;
      }
    }
    return null;
  }
}
