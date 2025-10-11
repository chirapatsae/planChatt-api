import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailService } from './email.service';
import { EmailTemplatesService } from './templates/email-templates.service';
import { EmailNotificationService } from './email-notification.service';
import { EmailController } from './email.controller';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, WorkHistory, BudgetPlan])],
  providers: [EmailService, EmailTemplatesService, EmailNotificationService],
  controllers: [EmailController],
  exports: [EmailService, EmailTemplatesService, EmailNotificationService],
})
export class EmailModule {}
