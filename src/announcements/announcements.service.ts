import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { Announcement, AnnouncementStatus, NotificationStatus, NotificationType } from './entities/announcement.entity';
import { AnnouncementRole } from 'src/announcement-roles/entities/announcement-role.entity';
import { Role } from 'src/roles/entities/role.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AnnouncementSchedulerService } from './announcement-scheduler.service';
import { UserNotificationsService } from '../user-notifications/user-notifications.service';
import { NotificationLogsService } from '../notification-logs/notification-logs.service';
import { WebsocketService } from '../websocket/websocket/websocket.service';

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectRepository(Announcement)
    private announcementRepository: Repository<Announcement>,
    @InjectRepository(AnnouncementRole)
    private announcementRoleRepository: Repository<AnnouncementRole>,
    @InjectRepository(Role)
    private roleRepository: Repository<Role>,
    @InjectRepository(WorkHistory)
    private workHistoryRepository: Repository<WorkHistory>,
    
    private readonly announcementSchedulerService: AnnouncementSchedulerService,
    private readonly userNotificationsService: UserNotificationsService,
    private readonly notificationLogsService: NotificationLogsService,
    private readonly websocketService: WebsocketService,
  ) {}

  async create(createAnnouncementDto: CreateAnnouncementDto, userId: string): Promise<Announcement> {
    const { roleIds, ...announcementData } = createAnnouncementDto;

    // Business logic validation
    if (announcementData.status === AnnouncementStatus.SCHEDULED && !announcementData.publishDateTime) {
      throw new Error('SCHEDULED announcements must have publishDateTime');
    }

    if (announcementData.status === AnnouncementStatus.PUBLISHED && announcementData.publishDateTime) {
      throw new Error('PUBLISHED announcements should not have publishDateTime');
    }

    const workHistory = await this.workHistoryRepository.findOne({ 
      where: { user: { id: userId } },
      relations: ['user']
    });
    
    if (!workHistory) {
      throw new NotFoundException(`Work history with user ID ${userId} not found`);
    }

    // Create the announcement
    const announcement = this.announcementRepository.create({
      ...announcementData,
      type: announcementData.type || NotificationType.ANNOUNCEMENT,
      // Convert string dates to Date objects
      publishDateTime: announcementData.publishDateTime ? new Date(announcementData.publishDateTime) : undefined,
      createdBy: { id: workHistory.id },
    });
    
    const savedAnnouncement = await this.announcementRepository.save(announcement);

    // If roleIds are provided, create the announcement-role relationships
    if (roleIds && roleIds.length > 0) {
      const roles = await this.roleRepository.findBy({ id: In(roleIds) });
      
      const announcementRoles = roles.map(role => 
        this.announcementRoleRepository.create({
          announcement: { id: savedAnnouncement.id },
          role: { id: role.id },
        })
      );

      await this.announcementRoleRepository.save(announcementRoles);
    }

    // If status is PUBLISHED, send notifications immediately
    if (savedAnnouncement.status === AnnouncementStatus.PUBLISHED) {
      savedAnnouncement.publishDateTime = new Date();
      savedAnnouncement.notificationStatus = NotificationStatus.PENDING;
      await this.announcementRepository.save(savedAnnouncement);
      
      // ต้องหา announcement ที่มี relations ก่อน
      const announcementWithRelations = await this.findOne(savedAnnouncement.id);
      
      // ส่ง notifications ทันที + บันทึก user_notifications
      await this.sendNotificationsAndCreateUserNotifications(announcementWithRelations);
    }

    // Schedule announcement if it's SCHEDULED
    if (savedAnnouncement.status === AnnouncementStatus.SCHEDULED) {
      // Ensure publishDateTime is set for scheduled announcements
      if (!savedAnnouncement.publishDateTime) {
        throw new Error('Scheduled announcements must have a publishDateTime');
      }
      await this.announcementSchedulerService.scheduleAnnouncement(savedAnnouncement);
    }

    return this.findOne(savedAnnouncement.id);
  }

  async findAll(): Promise<Announcement[]> {
    return this.announcementRepository.find({
      relations: ['createdBy', 'createdBy.user', 'announcementRoles', 'announcementRoles.role', 'createdBy.amphoe', 'createdBy.localAdministrativeOrganization'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Announcement> {
    const announcement = await this.announcementRepository.findOne({
      where: { id },
      relations: ['createdBy', 'createdBy.user', 'announcementRoles', 'announcementRoles.role'],
    });

    if (!announcement) {
      throw new NotFoundException(`Announcement with ID ${id} not found`);
    }

    return announcement;
  }

  async update(id: string, updateAnnouncementDto: UpdateAnnouncementDto, userId: string): Promise<Announcement> {
    const { roleIds, ...updateData } = updateAnnouncementDto;
    console.log(updateData);
    const announcement = await this.findOne(id);
    
    // Create a properly typed update object
    const updateObject: Partial<Announcement> = {
      ...updateData,
      // Convert string dates to Date objects
      publishDateTime: updateData.publishDateTime ? new Date(updateData.publishDateTime) : undefined,
    };
    
    // Update announcement data
    Object.assign(announcement, updateObject);
    await this.announcementRepository.save(announcement);

    // Update role relationships if roleIds are provided
    if (roleIds !== undefined) {
      // Remove existing role relationships
      await this.announcementRoleRepository.delete({ announcement: { id } });
      
      // Create new role relationships
      if (roleIds.length > 0) {
        const roles = await this.roleRepository.findBy({ id: In(roleIds) });
        
        const announcementRoles = roles.map(role => 
          this.announcementRoleRepository.create({
            announcement: { id },
            role: { id: role.id },
          })
        );

        await this.announcementRoleRepository.save(announcementRoles);
      }
    }

    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const announcement = await this.findOne(id);
    await this.announcementRepository.softDelete(id);
  }


  async getPendingNotifications(): Promise<Announcement[]> {
    return this.announcementRepository.find({
      where: { 
        status: AnnouncementStatus.PUBLISHED,
        notificationStatus: NotificationStatus.PENDING,
      },
      relations: ['announcementRoles', 'announcementRoles.role'],
    });
  }

  async updateNotificationStatus(id: string, status: NotificationStatus): Promise<Announcement> {
    const announcement = await this.findOne(id);
    announcement.notificationStatus = status;
    return this.announcementRepository.save(announcement);
  }

  async updateStatus(id: string, status: AnnouncementStatus): Promise<Announcement> {
    const announcement = await this.findOne(id);
    announcement.status = status;
    
    if (status === AnnouncementStatus.PUBLISHED) {
      announcement.publishDateTime = new Date();
      announcement.notificationStatus = NotificationStatus.PENDING;
    }
    
    return this.announcementRepository.save(announcement);
  }

  async getWorkHistoriesByRole(roleId: string): Promise<WorkHistory[]> {
    return this.workHistoryRepository.find({
      where: { role: { id: roleId } , workStatus: { name: 'approved' } },
      relations: ['user', 'role'],
    });
  }

  // ส่ง notifications และสร้าง user_notifications สำหรับ PUBLISHED announcements
  async sendNotificationsAndCreateUserNotifications(announcement: Announcement): Promise<void> {

    if (!announcement.announcementRoles || announcement.announcementRoles.length === 0) {
      console.log(`❌ No announcement roles assigned to announcement ${announcement.id}`);
      return;
    }

    const allWorkHistories: WorkHistory[] = [];
    const roleNames: string[] = [];
    
    // รวบรวม workHistories ของทุก roles และ role names
    for (const announcementRole of announcement.announcementRoles) {
      const workHistories = await this.getWorkHistoriesByRole(announcementRole.role.id);
      console.log(`Found ${workHistories.length} work histories for role ${announcementRole.role.name}`);
      allWorkHistories.push(...workHistories);
      roleNames.push(announcementRole.role.name);
      
      // บันทึก notification log
      try {
        await this.notificationLogsService.logSuccess(announcement.id, announcementRole.role.id);
      } catch (error) {
        console.error('Failed to log notification:', error);
      }
    }

    // สร้าง user_notifications สำหรับทุก users
    if (allWorkHistories.length > 0) {
      try {
        const result = await this.userNotificationsService.createBulk(announcement, allWorkHistories);
        console.log(`✅ Successfully created ${result.length} user notifications for ${allWorkHistories.length} users`);
      } catch (error) {
        console.error('❌ Failed to create user notifications:', error);
        throw error;
      }
    }

    // Broadcast announcement to role rooms (ย้ายมาไว้นอก if เพื่อให้พ่น log เสมอแม้ยังไม่มี user)
    try {
      await this.websocketService.broadcastAnnouncementToRoles({
        announcement: {
          id: announcement.id,
          type: announcement.type,
          title: announcement.title,
          description: announcement.description,
          status: announcement.status,
          publishDateTime: announcement.publishDateTime,
          createdBy: announcement.createdBy,
        },
        roleNames,
        message: `New ${announcement.type} published for roles: ${roleNames.join(', ')}`,
      });
      console.log(`📢 Successfully broadcasted announcement to ${roleNames.length} role rooms: ${roleNames.join(', ')}`);
    } catch (error) {
      console.error('❌ Failed to broadcast announcement to role rooms:', error);
      // ไม่ throw error เพราะไม่ต้องการให้ announcement creation ล้มเหลว
    }
      
    if (allWorkHistories.length === 0) { // This `else` block was originally part of `if (allWorkHistories.length > 0)`
      console.log(`⚠️ No work histories to create notifications for`);
    }

    // อัพเดท notification status เป็น SENT
    await this.updateNotificationStatus(announcement.id, NotificationStatus.SENT);
  }
}
