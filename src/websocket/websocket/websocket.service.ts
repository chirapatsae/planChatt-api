import { Injectable, Logger } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';

export interface WorkStatusUpdateNotification {
  userId: string;
  workStatus: string;
  workHistoryId: string;
  previousWorkStatus?: string;
  previousRole?: string;
  updatedBy?: string;
  role?: string;
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

  constructor(private readonly webSocketGateway: WebsocketGateway) { }

  /**
   * ส่ง notification เมื่อ work status เปลี่ยน
   */
  async notifyWorkStatusUpdate(notification: WorkStatusUpdateNotification) {
    try {
      const { userId, workStatus, workHistoryId, role, previousRole, previousWorkStatus, updatedBy } = notification;

      this.logger.log(
        `Sending work status update notification to user ${userId}: ${workStatus}`,
      );

      // ส่ง notification ไปยัง user เฉพาะ
      this.webSocketGateway.notifyWorkStatusUpdate(
        userId,
        workStatus,
        workHistoryId,
        role,
        previousRole,      // ← เพิ่ม previousRole
        previousWorkStatus, // ← เพิ่ม previousWorkStatus
        updatedBy,         // ← เพิ่ม updatedBy
      );

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
