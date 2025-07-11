import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  UseGuards,
  Query,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'users',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    this.logger.log('Creating user');
    try {
      return await this.usersService.create(createUserDto);
    } catch (error) {
      this.logger.error('Error creating user', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all users');
    try {
      return await this.usersService.findAll();
    } catch (error) {
      this.logger.error('Error fetching users', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching user ${id}`);
    try {
      return await this.usersService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching user ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    this.logger.log(`Updating user ${id}`);
    try {
      return await this.usersService.update(id, updateUserDto);
    } catch (error) {
      this.logger.error(`Error updating user ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    const action = mode === 'soft' ? 'Soft removing' : 'Hard removing';
    this.logger.warn(`${action} user ${id}`);
    try {
      return mode === 'soft'
        ? await this.usersService.softRemove(id)
        : await this.usersService.remove(id);
    } catch (error) {
      this.logger.error(`Error ${action.toLowerCase()} user ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Restoring user ${id}`);
    try {
      return await this.usersService.restore(id);
    } catch (error) {
      this.logger.error(`Error restoring user ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  private handleException(error: any) {
    if (error instanceof BadRequestException) return error;
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
