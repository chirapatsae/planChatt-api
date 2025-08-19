import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { Announcement, AnnouncementStatus, NotificationStatus } from './entities/announcement.entity';
import { AnnouncementRole } from 'src/announcement-roles/entities/announcement-role.entity';
import { Role } from 'src/roles/entities/role.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

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

    // If status is PUBLISHED, set notificationStatus to pending
    if (savedAnnouncement.status === AnnouncementStatus.PUBLISHED) {
      savedAnnouncement.publishDateTime = new Date();
      savedAnnouncement.notificationStatus = NotificationStatus.PENDING;
      await this.announcementRepository.save(savedAnnouncement);
    }

    return this.findOne(savedAnnouncement.id);
  }

  async findAll(): Promise<Announcement[]> {
    return this.announcementRepository.find({
      relations: ['createdBy', 'createdBy.user', 'announcementRoles', 'announcementRoles.role'],
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
    
    // Update announcement data
    Object.assign(announcement, updateData);
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

  // async findByStatus(status: AnnouncementStatus): Promise<Announcement[]> {
  //   return this.announcementRepository.find({
  //     where: { status },
  //     relations: ['createdBy', 'createdBy.user', 'announcementRoles', 'announcementRoles.role'],
  //     order: { createdAt: 'DESC' },
  //   });
  // }

  // async findByRole(roleId: string): Promise<Announcement[]> {
  //   const announcementRoles = await this.announcementRoleRepository.find({
  //     where: { role: { id: roleId } },
  //     relations: ['announcement', 'announcement.createdBy', 'announcement.createdBy.user', 'announcement.announcementRoles', 'announcement.announcementRoles.role'],
  //   });

  //   return announcementRoles.map(ar => ar.announcement);
  // }

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

  async updateNotificationStatusIfPending(id: string, newStatus: NotificationStatus): Promise<boolean> {
    // อัปเดต status เฉพาะเมื่อเป็น PENDING เท่านั้น (ป้องกัน race condition)
    const result = await this.announcementRepository.update(
      { 
        id, 
        notificationStatus: NotificationStatus.PENDING 
      },
      { 
        notificationStatus: newStatus 
      }
    );
    
    // result.affected > 0 หมายความว่ามีการอัปเดตสำเร็จ
    return (result.affected || 0) > 0;
  }

  async findScheduledAnnouncements(): Promise<Announcement[]> {
    const now = new Date();
    return this.announcementRepository
      .createQueryBuilder('announcement')
      .leftJoinAndSelect('announcement.announcementRoles', 'announcementRoles')
      .leftJoinAndSelect('announcementRoles.role', 'role')
      .where('announcement.status = :status', { status: AnnouncementStatus.SCHEDULED })
      .andWhere('announcement.publishDateTime <= :now', { now })
      .getMany();
  }

  async processScheduledToPublished(): Promise<void> {
    const scheduledAnnouncements = await this.findScheduledAnnouncements();
    
    for (const announcement of scheduledAnnouncements) {
      // Change status from SCHEDULED to PUBLISHED
      announcement.status = AnnouncementStatus.PUBLISHED;
      announcement.notificationStatus = NotificationStatus.PENDING;
      await this.announcementRepository.save(announcement);
    }
  }

  async findByWorkHistory(workHistoryId: string): Promise<Announcement[]> {
    return this.announcementRepository.find({
      where: { createdBy: { id: workHistoryId } },
      relations: ['announcementRoles', 'announcementRoles.role'],
      order: { createdAt: 'DESC' },
    });
  }

  async getWorkHistoriesByRole(roleId: string): Promise<WorkHistory[]> {
    return this.workHistoryRepository.find({
      where: { role: { id: roleId } },
      relations: ['user', 'role'],
    });
  }
}
