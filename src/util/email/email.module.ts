import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailService } from './email.service';
import { EmailTemplatesService } from './templates/email-templates.service';
import { EmailNotificationService } from './email-notification.service';
import { EmailController } from './email.controller';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, WorkHistory, DevelopmentPlan])],
  providers: [EmailService, EmailTemplatesService, EmailNotificationService],
  controllers: [EmailController],
  exports: [EmailService, EmailTemplatesService, EmailNotificationService],
})
export class EmailModule {}
