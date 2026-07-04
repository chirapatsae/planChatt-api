import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import {
  ListMessagesQueryDto,
  SendMessageDto,
  StartConversationDto,
} from '../dto/citizen-chat.dto';
import { CitizenChatService } from './citizen-chat.service';

const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // multer pre-reject (service re-validates)

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * Citizen CHAT surface — 1:1 direct messages (Community Chat Phase 1, §17.2
 * advisory). The acting identity is ALWAYS `req.user.identityId` (NEVER a
 * body/param). Every route is authenticated-only (the strict `CitizenJwtGuard`,
 * reads AND writes) — chat has no anonymous surface.
 */
@Controller({ path: 'citizen-engagement/chat', version: '1' })
export class CitizenChatController {
  constructor(private readonly chatService: CitizenChatService) {}

  @Post('conversations')
  @UseGuards(CitizenJwtGuard)
  startConversation(
    @Req() req: CitizenRequest,
    @Body() dto: StartConversationDto,
  ) {
    return this.chatService.startConversation(
      req.user.identityId,
      dto.participantId,
    );
  }

  @Get('conversations')
  @UseGuards(CitizenJwtGuard)
  listConversations(@Req() req: CitizenRequest) {
    return this.chatService.listConversations(req.user.identityId);
  }

  @Get('conversations/:id')
  @UseGuards(CitizenJwtGuard)
  getConversation(
    @Req() req: CitizenRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.getConversation(req.user.identityId, id);
  }

  @Get('conversations/:id/messages')
  @UseGuards(CitizenJwtGuard)
  listMessages(
    @Req() req: CitizenRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.chatService.listMessages(
      req.user.identityId,
      id,
      query.limit,
      query.beforeCreatedAt,
      query.beforeId,
    );
  }

  // Sending is the abuse-prone write — throttle it (mirrors CREATE_COMMENT).
  @Throttle({
    default: {
      limit: CITIZEN_RATE_LIMITS.SEND_MESSAGE,
      ttl: CITIZEN_THROTTLE_TTL_MS,
    },
  })
  @Post('conversations/:id/messages')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  sendMessage(
    @Req() req: CitizenRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(req.user.identityId, id, dto.body);
  }

  // Image message — same abuse cap as text send.
  @Throttle({
    default: {
      limit: CITIZEN_RATE_LIMITS.SEND_MESSAGE,
      ttl: CITIZEN_THROTTLE_TTL_MS,
    },
  })
  @Post('conversations/:id/messages/image')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: IMAGE_MAX_BYTES },
    }),
  )
  sendImageMessage(
    @Req() req: CitizenRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption?: string,
  ) {
    return this.chatService.sendImageMessage(req.user.identityId, id, file, caption);
  }

  // Participant-scoped image serve (private — unlike public post media).
  @Get('media/:messageId')
  @UseGuards(CitizenJwtGuard)
  async serveImage(
    @Req() req: CitizenRequest,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, contentType } = await this.chatService.getMessageImage(
      req.user.identityId,
      messageId,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return new StreamableFile(buffer);
  }

  @Post('conversations/:id/read')
  @UseGuards(CitizenJwtGuard)
  markRead(
    @Req() req: CitizenRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.markRead(req.user.identityId, id);
  }

  @Delete('messages/:id')
  @UseGuards(CitizenJwtGuard)
  deleteMessage(
    @Req() req: CitizenRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.deleteMessage(req.user.identityId, id);
  }

  @Get('unread-count')
  @UseGuards(CitizenJwtGuard)
  unreadCount(@Req() req: CitizenRequest) {
    return this.chatService.getUnreadCount(req.user.identityId);
  }
}
