import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAnnouncementRoleDto } from './dto/create-announcement-role.dto';
import { UpdateAnnouncementRoleDto } from './dto/update-announcement-role.dto';
import { AnnouncementRole } from './entities/announcement-role.entity';

@Injectable()
export class AnnouncementRolesService {
  constructor(
    @InjectRepository(AnnouncementRole)
    private announcementRoleRepository: Repository<AnnouncementRole>,
  ) {}

  // async create(createAnnouncementRoleDto: CreateAnnouncementRoleDto): Promise<AnnouncementRole> {
  //   const announcementRole = this.announcementRoleRepository.create(createAnnouncementRoleDto);
  //   return this.announcementRoleRepository.save(announcementRole);
  // }

  async findAll(): Promise<AnnouncementRole[]> {
    return this.announcementRoleRepository.find({
      relations: ['announcement', 'role'],
    });
  }

  async findOne(id: string): Promise<AnnouncementRole> {
    const announcementRole = await this.announcementRoleRepository.findOne({
      where: { id },
      relations: ['announcement', 'role'],
    });

    if (!announcementRole) {
      throw new NotFoundException(`AnnouncementRole with ID ${id} not found`);
    }

    return announcementRole;
  }

  async update(id: string, updateAnnouncementRoleDto: UpdateAnnouncementRoleDto): Promise<AnnouncementRole> {
    const announcementRole = await this.findOne(id);
    Object.assign(announcementRole, updateAnnouncementRoleDto);
    return this.announcementRoleRepository.save(announcementRole);
  }

  async remove(id: string): Promise<void> {
    const announcementRole = await this.findOne(id);
    await this.announcementRoleRepository.remove(announcementRole);
  }

  async findByAnnouncement(announcementId: string): Promise<AnnouncementRole[]> {
    return this.announcementRoleRepository.find({
      where: { announcement: { id: announcementId } },
      relations: ['role'],
    });
  }

  async findByRole(roleId: string): Promise<AnnouncementRole[]> {
    return this.announcementRoleRepository.find({
      where: { role: { id: roleId } },
      relations: ['announcement'],
    });
  }
}
