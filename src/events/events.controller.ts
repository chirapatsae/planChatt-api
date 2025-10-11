import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Patch, 
  Param, 
  Delete, 
  UseGuards, 
  Query, 
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Request } from 'express';

@Controller({
  path: 'events',
  version: '1',
})
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    private readonly eventsService: EventsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() createEventDto: CreateEventDto,
    @Req() req: Request & { user: JwtPayloadUser }
  ): Promise<EventResponseDto> {
    this.logger.log(`Creating new event: ${createEventDto.title}`);
    return this.eventsService.create(createEventDto, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('dateFilter') dateFilter?: string,
    @Query('location') location?: string,
  ): Promise<EventResponseDto[]> {
    return this.eventsService.findAll({ search, status, dateFilter, location });
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<EventResponseDto> {
    this.logger.log(`Fetching event with ID: ${id}`);
    return this.eventsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string, 
    @Body() updateEventDto: UpdateEventDto,
    @Req() req: Request & { user: JwtPayloadUser }
  ): Promise<EventResponseDto> {
    this.logger.log(`Updating event with ID: ${id}`);
    return this.eventsService.update(id, updateEventDto, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser }
  ): Promise<void> {
    this.logger.log(`Deleting event with ID: ${id}`);
    return this.eventsService.remove(id, req.user.userId);
  }
}
