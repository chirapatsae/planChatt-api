import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateAuthDto } from './dto/create-auth.dto';
import { SecretKeyGuard } from './secret-key.guard';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('oauth-login')
  @UseGuards(SecretKeyGuard)
  async oauthLogin(@Body() dto: CreateAuthDto) {
    return this.authService.handleOAuthLogin(
      dto.id_token,
      dto.division_id,
      dto.division_name,
    );
  }
}
