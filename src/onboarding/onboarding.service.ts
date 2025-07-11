import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { OnboardDto } from './dto/onboard.dto';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Onboards a user by updating their details and managing their work history within a transaction.
   * @param onboardDto - The onboarding data.
   * @returns The new or existing approved work history.
   */
  async onboardUserAndWorkHistory(onboardDto: OnboardDto): Promise<WorkHistory> {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const workHistoryRepo = manager.getRepository(WorkHistory);
      const { userId, email, phone, amphoeId, localAdministrativeOrganizationId } = onboardDto;

      // Step 1: Update user's contact info and login status
      await userRepo.update(userId, { email, phone, isFirstLogin: false });

      // Step 2: Check for a currently approved work history
      const currentApproved = await workHistoryRepo.findOne({
        where: { user: { id: userId }, status: 'approved' },
        relations: ['amphoe', 'localAdministrativeOrganization'],
      });

      // Step 3: If the new work details match the current ones, do nothing further.
      const isSameWorkHistory =
        currentApproved &&
        currentApproved.amphoe?.id === amphoeId &&
        currentApproved.localAdministrativeOrganization?.id === localAdministrativeOrganizationId;

      if (isSameWorkHistory) {
        this.logger.log(`Work history for user ${userId} is already up-to-date.`);
        return currentApproved;
      }

      // Step 4: Suspend all existing work histories for the user
      await workHistoryRepo.update({ user: { id: userId } }, { status: 'suspended' });

      // Step 5: Create a new, approved work history
      const newHistory = workHistoryRepo.create({
        user: { id: userId },
        amphoe: { id: amphoeId },
        localAdministrativeOrganization: { id: localAdministrativeOrganizationId },
        status: 'approved',
      });

      return workHistoryRepo.save(newHistory);
    });
  }
} 