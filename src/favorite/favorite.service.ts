import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { Favorite } from './entities/favorite.entity';

@Injectable()
export class FavoriteService {
  private readonly logger = new Logger(FavoriteService.name);

  constructor(
    @InjectRepository(Favorite)
    private readonly favoriteRepo: Repository<Favorite>,
  ) {}

  async create(createFavoriteDto: CreateFavoriteDto, userId: string): Promise<Favorite> {
    try {
      // Check if favorite already exists
      const existingFavorite = await this.favoriteRepo.findOne({
        where: {
          projectGroupId: { id: createFavoriteDto.projectGroupId },
          userId: { id: userId },
        },
      });

      if (existingFavorite) {
        throw new ConflictException('This project is already in favorites');
      }

      const favorite = this.favoriteRepo.create({
        projectGroupId: { id: createFavoriteDto.projectGroupId },
        userId: { id: userId },
      });

      return await this.favoriteRepo.save(favorite);
    } catch (error) {
      this.logger.error(`Error creating favorite: ${error.message}`, error.stack);
      throw error;
    }
  }


  async findByUserId(userId: string): Promise<Favorite[]> {
    try {
      return await this.favoriteRepo.find({
        where: { userId: { id: userId } },
        relations: ['projectGroupId', 'userId'],
        order: { id: 'DESC' },
      });
    } catch (error) {
      this.logger.error(`Error fetching user favorites: ${error.message}`, error.stack);
      throw error;
    }
  }



  async removeByUserAndProject(userId: string, projectGroupId: string): Promise<void> {
    try {
      const favorite = await this.favoriteRepo.findOne({
        where: {
          projectGroupId: { id: projectGroupId },
          userId: { id: userId },
        },
      });
      
      if (!favorite) {
        throw new NotFoundException('Favorite not found for this user and project');
      }
      
      await this.favoriteRepo.remove(favorite);
    } catch (error) {
      this.logger.error(`Error removing favorite: ${error.message}`, error.stack);
      throw error;
    }
  }


}
