import { Controller, Get, Post, Body, Patch, Param, Delete, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { ExecutiveService } from './executive.service';
import { CreateExecutiveDto } from './dto/create-executive.dto';
import { UpdateExecutiveDto } from './dto/update-executive.dto';

@Controller({
  path: 'executive',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ExecutiveController {
  constructor(private readonly executiveService: ExecutiveService) { }

  @Get('team-dashboard')
  getTeamDashboard(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.executiveService.getTeamDashboard(req.user.userId);
  }

  @Post()
  create(@Body() createExecutiveDto: CreateExecutiveDto) {
    return this.executiveService.create(createExecutiveDto);
  }

  @Get()
  findAll() {
    return this.executiveService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.executiveService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateExecutiveDto: UpdateExecutiveDto) {
    return this.executiveService.update(+id, updateExecutiveDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.executiveService.remove(+id);
  }
}
