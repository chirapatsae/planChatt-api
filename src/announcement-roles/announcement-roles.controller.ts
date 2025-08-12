import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { AnnouncementRolesService } from './announcement-roles.service';
import { CreateAnnouncementRoleDto } from './dto/create-announcement-role.dto';
import { UpdateAnnouncementRoleDto } from './dto/update-announcement-role.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller(
  {
    version: '1',
    path: 'announcement-roles',
  }
)
@UseGuards(JwtAuthGuard)
export class AnnouncementRolesController {
  constructor(private readonly announcementRolesService: AnnouncementRolesService) {}

  // @Post()
  // create(@Body() createAnnouncementRoleDto: CreateAnnouncementRoleDto) {
  //   return this.announcementRolesService.create(createAnnouncementRoleDto);
  // }

  @Get()
  findAll() {
    return this.announcementRolesService.findAll();
  }

  @Get('announcement/:announcementId')
  findByAnnouncement(@Param('announcementId') announcementId: string) {
    return this.announcementRolesService.findByAnnouncement(announcementId);
  }

  @Get('role/:roleId')
  findByRole(@Param('roleId') roleId: string) {
    return this.announcementRolesService.findByRole(roleId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.announcementRolesService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateAnnouncementRoleDto: UpdateAnnouncementRoleDto) {
    return this.announcementRolesService.update(id, updateAnnouncementRoleDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.announcementRolesService.remove(id);
  }
}
