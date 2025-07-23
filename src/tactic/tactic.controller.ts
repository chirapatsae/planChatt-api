import {
  Controller,
  Get,
  Param,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  UseGuards,
  Post,
  Body,
  Patch,
  Delete,
  Query,
  Req,
} from '@nestjs/common';
import { TacticService } from './tactic.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { CreateTacticDto } from './dto/create-tactic.dto';
import { UpdateTacticDto } from './dto/update-tactic.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'tactic',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class TacticController {
  private readonly logger = new Logger(TacticController.name);

  constructor(private readonly tacticService: TacticService) { }

  @Get()
  async findAll() {
    return await this.tacticService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return await this.tacticService.findOne(id);
  }

  @Post()
  create(@Body() createTacticDto: CreateTacticDto, @Req() req: Request & { user: JwtPayloadUser }) {
    return this.tacticService.create(createTacticDto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateTacticDto: UpdateTacticDto,
  ) {
    return this.tacticService.update(id, updateTacticDto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser }
  ) {
    return mode === 'soft'
      ? this.tacticService.softRemove(id, req.user.userId)
      : this.tacticService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.tacticService.restore(id);
  }
  
}
