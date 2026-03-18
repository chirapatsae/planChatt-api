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
    origin: ['http://localhost:5173', 'https://pb.koratpao.go.th'],
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
  private connectedClients = new Map<string, { userId: string; socket: Socket; roles: string[] }>();

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
    
    // Store client connection with userId and empty roles array
    this.connectedClients.set(client.id, { userId, socket: client, roles: [] });
    
    this.logger.log(`User ${userId} joined room: user-${userId}`);
    
    // Send confirmation
    client.emit('joined-room', { 
      message: `Joined room for user ${userId}`,
      room: `user-${userId}`
    });
  }

  @SubscribeMessage('join-role-room')
  handleJoinRoleRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roleName: string },
  ) {
    const { roleName } = data;
    
    // Join role-specific room
    client.join(`role-${roleName}`);
    
    // Update client's roles in connectedClients
    const clientInfo = this.connectedClients.get(client.id);
    if (clientInfo) {
      if (!clientInfo.roles.includes(roleName)) {
        clientInfo.roles.push(roleName);
      }
    }
    
    this.logger.log(`Client ${client.id} joined role room: role-${roleName}`);
    
    // Send confirmation
    client.emit('joined-room', { 
      message: `Joined role room: ${roleName}`,
      room: `role-${roleName}`
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

  @SubscribeMessage('leave-role-room')
  handleLeaveRoleRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roleName: string },
  ) {
    const { roleName } = data;
    
    // Leave role-specific room
    client.leave(`role-${roleName}`);
    
    // Update client's roles in connectedClients
    const clientInfo = this.connectedClients.get(client.id);
    if (clientInfo) {
      clientInfo.roles = clientInfo.roles.filter(role => role !== roleName);
    }
    
    this.logger.log(`Client ${client.id} left role room: role-${roleName}`);
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

  // Method to broadcast announcement to role rooms
  broadcastAnnouncementToRoles(roleNames: string[], announcement: any) {
    for (const roleName of roleNames) {
      const roomName = `role-${roleName}`;
      this.server.to(roomName).emit('announcement', {
        type: 'announcement',
        announcement,
        role: roleName,
        timestamp: new Date().toISOString(),
        message: `New announcement published for role: ${roleName}`,
      });
      
      this.logger.log(`Broadcasted announcement to role room: ${roomName}`);
    }
  }


  // Get connected clients info for debugging
  getConnectedClients() {
    return Array.from(this.connectedClients.entries()).map(([socketId, { userId, roles }]) => ({
      socketId,
      userId,
      roles,
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

  // Get all clients in a specific role room
  getClientsInRoleRoom(roleName: string): string[] {
    const clients: string[] = [];
    for (const [socketId, value] of this.connectedClients.entries()) {
      if (value.roles.includes(roleName)) {
        clients.push(socketId);
      }
    }
    return clients;
  }

  // Method to notify specific user about PDF generation progress
  notifyPdfGenerationProgress(
    userId: string,
    developmentPlanId: string,
    progress: {
      percentage: number;
      stage: string;
      message?: string;
    },
  ) {
    this.server.to(`user-${userId}`).emit('pdf-generation-progress', {
      userId,
      developmentPlanId,
      progress: {
        percentage: progress.percentage,
        stage: progress.stage,
        message: progress.message,
      },
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `PDF generation progress for user ${userId}, plan ${developmentPlanId}: ${progress.percentage}% - ${progress.stage}`,
    );
  }
}
