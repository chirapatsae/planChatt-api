import { Controller, Get, Post, Body, Patch, Param, Delete, Query, Res, HttpStatus, BadRequestException, InternalServerErrorException, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateAuthDto } from './dto/create-auth.dto';
import { UpdateAuthDto } from './dto/update-auth.dto';
import { Response } from 'express'; // ✅ Make sure this import is from express
import axios from 'axios';
import * as jwt from 'jsonwebtoken'; // ใช้แค่ decode ไม่ต้อง verify
import { SecretKeyGuard } from './secret-key.guard';

@Controller({path : 'auth' , version  : '1'})
export class AuthController {
  constructor(private readonly authService: AuthService) {}



  @Post('oauth-login')
  @UseGuards(SecretKeyGuard)
  async oauthLogin(@Body() dto: CreateAuthDto) {
    return this.authService.handleOAuthLogin(dto.id_token , dto.division_id , dto.division_name);
  }

  @Post()
  create(@Body() createAuthDto: CreateAuthDto) {
    return this.authService.create(createAuthDto);
  }

  @Get()
  findAll() {
    return this.authService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.authService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateAuthDto: UpdateAuthDto) {
    return this.authService.update(+id, updateAuthDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.authService.remove(+id);
  }
}
