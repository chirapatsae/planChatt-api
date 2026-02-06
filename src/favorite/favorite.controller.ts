import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Param, 
  Delete, 
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FavoriteService } from './favorite.service';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { Favorite } from './entities/favorite.entity';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'favorite',
  version: '1',
})
@UseGuards(JwtAuthGuard)  
export class FavoriteController {
  constructor(private readonly favoriteService: FavoriteService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() createFavoriteDto: CreateFavoriteDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<Favorite> {
    return await this.favoriteService.create(createFavoriteDto, req.user.userId);
  }

  @Get('user/:userId')
  async findByUserId(@Param('userId') userId: string): Promise<Favorite[]> {
    return await this.favoriteService.findByUserId(userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<void> {
    return await this.favoriteService.remove(id, req.user.userId);
  }
}
