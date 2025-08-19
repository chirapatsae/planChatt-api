import { Injectable, Logger } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';

export interface WorkStatusUpdateNotification {
  userId: string;
  workStatus: string;
  workHistoryId: string;
  previousWorkStatus?: string;
  updatedBy?: string;
  timestamp: Date;
}

export interface GeneralNotification {
  userId: string;
  event: string;
  data: any;
}

@Injectable()
export class WebsocketService {
  private readonly logger = new Logger(WebsocketService.name);

  constructor(private readonly webSocketGateway: WebsocketGateway) {}

  /**
   * ส่ง notification เมื่อ work status เปลี่ยน
   */
  async notifyWorkStatusUpdate(notification: WorkStatusUpdateNotification) {
    try {
      const { userId, workStatus, workHistoryId } = notification;

      this.logger.log(
        `Sending work status update notification to user ${userId}: ${workStatus}`,
      );

      // ส่ง notification ไปยัง user เฉพาะ
      this.webSocketGateway.notifyWorkStatusUpdate(
        userId,
        workStatus,
        workHistoryId,
      );

      // ถ้า work status เป็น 'approved' ให้ส่ง broadcast ไปยัง admin ทั้งหมด
      if (workStatus === 'approved') {
        this.webSocketGateway.broadcastToAll('work-status-approved', {
          workStatus,
          workHistoryId,
          userId,
          message: `Work status approved for user ${userId}`,
        });
      }

      return {
        success: true,
        message: `Notification sent successfully to user ${userId}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to send work status update notification: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * ส่ง notification ทั่วไปไปยัง user เฉพาะ
   */
  async notifyUser(notification: GeneralNotification) {
    try {
      const { userId, event, data } = notification;

      this.logger.log(
        `Sending ${event} notification to user ${userId}`,
      );

      this.webSocketGateway.notifyUser(userId, event, data);

      return {
        success: true,
        message: `Notification sent successfully to user ${userId}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to send notification to user ${notification.userId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * ส่ง notification ไปยัง room เฉพาะ
   */
  async notifyRoom(roomName: string, event: string, data: any) {
    try {
      this.logger.log(
        `Sending ${event} notification to room ${roomName}`,
      );

      this.webSocketGateway.notifyRoom(roomName, event, data);

      return {
        success: true,
        message: `Notification sent successfully to room ${roomName}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to send notification to room ${roomName}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * ส่ง broadcast ไปยัง clients ทั้งหมด
   */
  async broadcastToAll(event: string, data: any) {
    try {
      this.logger.log(
        `Broadcasting ${event} to all clients`,
      );

      this.webSocketGateway.broadcastToAll(event, data);

      return {
        success: true,
        message: `Broadcast sent successfully to all clients`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to broadcast ${event}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * ตรวจสอบว่า user เชื่อมต่ออยู่หรือไม่
   */
  isUserConnected(userId: string): boolean {
    return this.webSocketGateway.isUserConnected(userId);
  }

  /**
   * ดึงข้อมูล connected clients
   */
  getConnectedClients() {
    return this.webSocketGateway.getConnectedClients();
  }

  /**
   * ส่ง notification เมื่อ work status เปลี่ยนเป็น 'approved'
   */
  async notifyWorkStatusApproved(
    userId: string,
    workHistoryId: string,
    updatedBy: string,
  ) {
    return this.notifyWorkStatusUpdate({
      userId,
      workStatus: 'approved',
      workHistoryId,
      updatedBy,
      timestamp: new Date(),
    });
  }

  /**
   * ส่ง notification เมื่อ work status เปลี่ยนเป็น 'pending'
   */
  async notifyWorkStatusPending(
    userId: string,
    workHistoryId: string,
    updatedBy: string,
  ) {
    return this.notifyWorkStatusUpdate({
      userId,
      workStatus: 'pending',
      workHistoryId,
      updatedBy,
      timestamp: new Date(),
    });
  }

  /**
   * ส่ง notification เมื่อ work status เปลี่ยนเป็น 'rejected'
   */
  async notifyWorkStatusRejected(
    userId: string,
    workHistoryId: string,
    updatedBy: string,
    reason?: string,
  ) {
    return this.notifyWorkStatusUpdate({
      userId,
      workStatus: 'rejected',
      workHistoryId,
      updatedBy,
      timestamp: new Date(),
    });
  }
}
