import { Controller, Post, Body, Logger, Req, UseGuards } from '@nestjs/common';
import { EmailNotificationService, EmailNotificationRequest, EmailType } from './email-notification.service';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { SendProjectListEmailDto } from './dto/email.dto';


@UseGuards(JwtAuthGuard)
@Controller({
    path: 'email',
    version: '1',
})
export class EmailController {
    private readonly logger = new Logger(EmailController.name);

    constructor(
        private readonly emailNotificationService: EmailNotificationService,
    ) { }

    @Post('project-list')
    async sendProjectListEmail(
        @Body() dto: SendProjectListEmailDto,
        @Req() req: Request & { user: JwtPayloadUser },
    ) {
        try {
            const result = await this.emailNotificationService.sendProjectListEmail(
                dto.listData,
                req.user.userId,
                dto.customSubject,
                dto.type as EmailType,
                dto.reviewerName
            );

            return {
                success: result.success,
                messageId: result.messageId,
                error: result.error,
                message: result.success ? 'Email sent successfully' : 'Failed to send email'
            };
        } catch (error) {
            this.logger.error('Error in sendProjectListEmail:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Failed to send email'
            };
        }
    }


}
