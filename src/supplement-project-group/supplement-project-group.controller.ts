import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Logger,
  Query,
} from '@nestjs/common';
import { SupplementProjectGroupService } from './supplement-project-group.service';
import { CreateSupplementProjectGroupDto } from './dto/create-supplement-project-group.dto';
import { UpdateSupplementProjectGroupDto } from './dto/update-supplement-project-group.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({ path: 'supplement-project-group', version: '1' })
@UseGuards(JwtAuthGuard)
export class SupplementProjectGroupController {
  private readonly logger = new Logger(SupplementProjectGroupController.name);

  constructor(
    private readonly supplementProjectGroupService: SupplementProjectGroupService,
  ) {}

  @Post()
  async create(
    @Body() createDto: CreateSupplementProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating supplement project group by user ${userId}`);
    return this.supplementProjectGroupService.create(createDto, userId);
  }

  @Get()
  async findAll(@Query('supplementId') supplementId?: string) {
    if (supplementId) {
      return this.supplementProjectGroupService.findBySupplement(supplementId);
    }
    this.logger.log('Fetching all supplement project groups');
    return this.supplementProjectGroupService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching supplement project group with id: ${id}`);
    return this.supplementProjectGroupService.findOne(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateSupplementProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Updating supplement project group with id: ${id}`);
    return this.supplementProjectGroupService.update(id, updateDto, userId);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    this.logger.log(`Removing supplement project group with id: ${id}`);
    return this.supplementProjectGroupService.remove(id);
  }
}


