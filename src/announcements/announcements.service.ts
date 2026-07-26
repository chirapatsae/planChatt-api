import { Injectable, NotFoundException, Logger } from '@nestjs/common';
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
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

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
    private readonly eventEmitter: EventEmitter2,
    // W89B — used to decrypt `announcement.createdBy.user` at the
    // response boundary. The Announcement entity is returned directly
    // (no DTO transform) by findAll/findOne, so without this the FE
    // would receive `iv:ciphertext` email/phone strings.
    private readonly usersService: UsersService,
  ) { }

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

  /**
   * Targeted in-app (bell) notification for the project workflow lifecycle.
   *
   * Unlike `create()` (role-fanout via AnnouncementRole rows), this delivers
   * to a specific set of recipients resolved by the workflow dispatcher — the
   * SAME recipients as the email/LINE channels. It writes NO AnnouncementRole
   * rows; delivery is per-user via `UserNotificationsService.createBulk`.
   *
   * ALWAYS sent (in-app is not gated on any preference — decoupled from
   * email/LINE). Best-effort + advisory: the whole body is wrapped in
   * try/catch and NEVER throws, so an in-app failure cannot cascade into the
   * workflow transition (§4.1).
   */
  async createTargetedProjectNotification(
    recipients: { userId: string; workHistoryId: string }[],
    input: { title: string; description: string },
    actorUserId: string | null,
  ): Promise<void> {
    if (!recipients || recipients.length === 0) {
      return;
    }
    try {
      // Resolve the actor's WorkHistory for `createdBy` — same lookup as
      // create(). Missing actor (or not found) → leave createdBy undefined.
      let createdBy: { id: string } | undefined = undefined;
      if (actorUserId) {
        const workHistory = await this.workHistoryRepository.findOne({
          where: { user: { id: actorUserId } },
          relations: ['user'],
        });
        if (workHistory) {
          createdBy = { id: workHistory.id };
        }
      }

      const announcement = this.announcementRepository.create({
        type: NotificationType.PROJECT,
        status: AnnouncementStatus.PUBLISHED,
        title: input.title,
        description: input.description,
        publishDateTime: new Date(),
        notificationStatus: NotificationStatus.SENT,
        createdBy,
      });
      const savedAnnouncement = await this.announcementRepository.save(announcement);

      // Per-user delivery. createBulk only reads `wh.user.id` + `wh.user`, so
      // a minimal `{ user: { id } }` object is a sufficient work-history stand-in.
      await this.userNotificationsService.createBulk(
        savedAnnouncement,
        recipients.map((r) => ({ user: { id: r.userId } })),
      );
    } catch (err) {
      this.logger.error(
        `Failed to create targeted project notification: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  async findAll(): Promise<Announcement[]> {
    const announcements = await this.announcementRepository.find({
      relations: ['createdBy', 'createdBy.user', 'announcementRoles', 'announcementRoles.role', 'createdBy.amphoe', 'createdBy.localAdministrativeOrganization'],
      order: { createdAt: 'DESC' },
      where: { type: NotificationType.ANNOUNCEMENT }
    });

    // W89B — decrypt the embedded creator User entity on every row before
    // returning. `decryptUserPii` is idempotent (ciphertext-shape guarded)
    // so this is safe even if a future caller pre-decrypts. Sequential
    // decrypt is acceptable at current scale per W89B brief.
    for (const a of announcements) {
      if (a.createdBy?.user) {
        await this.usersService.decryptUserPii(a.createdBy.user);
      }
    }
    return announcements;
  }

  async findOne(id: string): Promise<Announcement> {
    const announcement = await this.announcementRepository.findOne({
      where: { id },
      relations: ['createdBy', 'createdBy.user', 'announcementRoles', 'announcementRoles.role'],
    });

    if (!announcement) {
      throw new NotFoundException(`Announcement with ID ${id} not found`);
    }

    // W89B — decrypt creator's email/phone before returning. Same rationale
    // as findAll above.
    if (announcement.createdBy?.user) {
      await this.usersService.decryptUserPii(announcement.createdBy.user);
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
      where: { role: { id: roleId }, workStatus: { name: 'approved' }, isCurrent: true },
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

    // กำจัด User ซ้ำ (ในกรณีที่ User หนึ่งคนมีหลาย Role และประกาศส่งไปหลาย Role)
    const uniqueWorkHistoriesMap = new Map<string, WorkHistory>();
    for (const wh of allWorkHistories) {
      if (wh.user && wh.user.id) {
        uniqueWorkHistoriesMap.set(wh.user.id, wh);
      }
    }
    const uniqueWorkHistories = Array.from(uniqueWorkHistoriesMap.values());

    // สร้าง user_notifications สำหรับทุก users
    if (uniqueWorkHistories.length > 0) {
      try {
        const result = await this.userNotificationsService.createBulk(announcement, uniqueWorkHistories);
        console.log(`✅ Successfully created ${result.length} user notifications`);
      } catch (error) {
        console.error('❌ Failed to create user notifications:', error);
        throw error;
      }
    }

    // Broadcast announcement via Event (ใช้ EventEmitter แทน setTimeout)
    this.eventEmitter.emit('announcement.published', {
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
    });

    if (allWorkHistories.length === 0) { // This `else` block was originally part of `if (allWorkHistories.length > 0)`
      console.log(`⚠️ No work histories to create notifications for`);
    }

    // อัพเดท notification status เป็น SENT
    await this.updateNotificationStatus(announcement.id, NotificationStatus.SENT);
  }

  // Listener สำหรับจัดการการส่ง Socket หลังบันทึกข้อมูลเสร็จ
  @OnEvent('announcement.published', { async: true })
  async handleAnnouncementPublished(payload: { announcement: any, roleNames: string[] }) {
    const { announcement, roleNames } = payload;

    // หน่วงเวลาเล็กน้อย (Optional) เพื่อให้แน่ใจว่า Transaction อื่นๆ (ถ้ามี) Commit เสร็จ
    // หรือจะส่งทันทีก็ได้เพราะ OnEvent(async: true) จะทำงานแยกจาก Main Thread หลัก
    try {
      await this.websocketService.broadcastAnnouncementToRoles({
        announcement,
        roleNames,
        message: `New ${announcement.type} published for roles: ${roleNames.join(', ')}`,
      });
      console.log(`📢 [Event] Successfully broadcasted announcement to ${roleNames.length} role rooms: ${roleNames.join(', ')}`);
    } catch (error) {
      console.error('❌ [Event] Failed to broadcast announcement:', error);
    }
  }
}
