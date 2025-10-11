import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailTemplatesService } from './templates/email-templates.service';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Repository } from 'typeorm';
import { ProjectListData } from './dto/email.dto';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';

export type EmailType = "SendToVerify" | "SentToEdit" | "Custom";

export interface EmailNotificationRequest {
  type: EmailType;
  to: string | string[];
  subject?: string;
  data: ProjectListData | any;
  budgetPlan?: any;
  workHistory?: string;
  customSubject?: string;
  customText?: string;
  customHtml?: string;
  totalCount?: number;
  reviewerName?: string;
}

@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepository: Repository<BudgetPlan>
  ) {}

  /**
   * ส่งอีเมลตาม type ที่ระบุ
   */
  async sendNotification(request: EmailNotificationRequest): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      let subject: string;
      let text: string;
      let html: string;
      let budgetPlan = request.budgetPlan;
      let workHistory = request.workHistory;
      let totalCount = request.totalCount;

      switch (request.type) {
        case 'SendToVerify':
          const listData = request.data as ProjectListData[];
          subject = request.customSubject || `แจ้งการนำส่งโครงการเพื่อตรวจสอบ รายการโครงการ - (${totalCount} รายการ)`;
          text = this.emailTemplatesService.generateProjectListText(listData, budgetPlan, workHistory || '', totalCount || 0);
          html = this.emailTemplatesService.generateProjectListHTML(listData, budgetPlan, workHistory || '', totalCount || 0);
          break;
        case 'SentToEdit':
          const editListData = request.data as ProjectListData[];
          subject = request.customSubject || `แจ้งการส่งโครงการเพื่อแก้ไข รายการโครงการ - (${totalCount} รายการ)`;
          text = this.emailTemplatesService.generateProjectEditText(editListData, budgetPlan, workHistory || '', request.reviewerName || 'ผู้ตรวจสอบ');
          html = this.emailTemplatesService.generateProjectEditHTML(editListData, budgetPlan, workHistory || '', request.reviewerName || 'ผู้ตรวจสอบ');
          break;
        default:
          throw new Error(`Unsupported email type: ${request.type}`);
      }

      const result = await this.emailService.sendEmail({
        to: request.to,
        subject,
        text,
        html,
      });

      if (result.success) {
        this.logger.log(`Email sent successfully: ${request.type} to ${Array.isArray(request.to) ? request.to.join(', ') : request.to}`);
      } else {
        this.logger.error(`Failed to send email: ${result.error}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Error sending ${request.type} email:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }


  async sendProjectListEmail(
    listData: ProjectListData[],
    userId: string,
    customSubject?: string,
    type: EmailType = "SendToVerify",
    reviewerName?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const budgetPlan = await this.budgetPlanRepository.findOne({
      where: {isLatest: true},
    });
    if (!budgetPlan) {
      return {
        success: false,
        error: 'Budget plan not found'
      };
    }
    const user = await this.userRepository.findOne({
      where: {id: userId}, 
      relations: ["workHistory", "workHistory.governmentAgencies", "workHistory.localAdministrativeOrganization"]
    });
   
    if (!user?.workHistory || user.workHistory.length === 0) {
      return {
        success: false,
        error: 'User work history not found'
      };
    }

    // Get the current work history (assuming the first one is current)
    const currentWorkHistory = user.workHistory[0];
    let listUsers: WorkHistory[] = [];
    
    if (currentWorkHistory.governmentAgencies) {
      listUsers = await this.workHistoryRepository.find({
        where: { governmentAgencies: { id: currentWorkHistory.governmentAgencies.id } },
        relations: ["user"]
      });
    } else if (currentWorkHistory.localAdministrativeOrganization) {
      listUsers = await this.workHistoryRepository.find({
        where: { localAdministrativeOrganization: { id: currentWorkHistory.localAdministrativeOrganization.id } },
        relations: ["user"]
      });
    }
    
    const emailAddresses = listUsers
      .map(workHistory => workHistory.user?.email)
      .filter((email): email is string => email !== undefined); // Type guard to filter out undefined
    
    if (emailAddresses.length === 0) {
      return {
        success: false,
        error: 'No valid email addresses found for the organization'
      };
    }
    
    // Get organization name from work history
    const organizationName = currentWorkHistory.governmentAgencies 
      ? currentWorkHistory.governmentAgencies.name 
      : currentWorkHistory.localAdministrativeOrganization?.name || 'Unknown Organization';

    // Process each list data item
    await this.sendNotification({
      type: type,
      // to: emailAddresses,
      to: ["skull.death1994@gmail.com"],
      data: listData,
      budgetPlan: budgetPlan,
      workHistory: organizationName,
      totalCount: listData.length,
      customSubject,
      reviewerName: reviewerName,
    });
    
    return {
      success: true,
      messageId: 'multiple_emails_sent'
    };
  }

}
