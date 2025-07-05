import { Controller, Get, Post, Body, Patch, Param, Delete, Logger, ConflictException, BadRequestException, NotFoundException, InternalServerErrorException, Req, UseGuards } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  version: '1',
  path: 'comments'
})
@UseGuards(JwtAuthGuard)
export class CommentsController {
  private readonly logger = new Logger(CommentsController.name);
  constructor(private readonly commentsService: CommentsService) { }

  @Post()
  create(@Body() createCommentDto: CreateCommentDto) {
    this.logger.log('Creating a new comment');
    try {
      return this.commentsService.create(createCommentDto);
    } catch (error) {
      this.logger.error('Error creating comment', error.stack);
      if (error instanceof ConflictException || error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error; // Re-throw known exceptions
      }
      throw new InternalServerErrorException('Unexpected error occurred');
    }
  }

  @Get('tracking-status/:id')
  findByTrackingStatus(@Param('id') id: string) {
    try {
      this.logger.log(`Fetching comments for tracking status ID: ${id}`);
      return this.commentsService.findByTrackingStatus(id);
    } catch (error) {
      this.logger.error('Error fetching comments', error.stack);
  
      if (error instanceof NotFoundException) {
        throw error; // ส่งต่อ error ที่รู้จัก
      }
  
      throw new InternalServerErrorException('Unexpected error occurred');
    }
  }
  
}

