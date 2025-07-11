import { Controller, Post, Body } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardDto } from './dto/onboard.dto';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Post()
  async onboardUser(@Body() onboardDto: OnboardDto) {
    return this.onboardingService.onboardUserAndWorkHistory(onboardDto);
  }
} 