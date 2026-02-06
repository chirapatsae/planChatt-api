import { Injectable, NotFoundException, ConflictException, Logger, BadRequestException } from '@nestjs/common';
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
      let existingFavorite: Favorite | null;
      
      if (createFavoriteDto.projectType === 'original') {
        existingFavorite = await this.favoriteRepo.findOne({
          where: {
            projectGroupId: { id: createFavoriteDto.projectId },
            userId: { id: userId },
          },
        });

        if (existingFavorite) {
          throw new ConflictException('Favorite already exists for this project');
        }

        const favorite = this.favoriteRepo.create({
          projectGroupId: { id: createFavoriteDto.projectId },
          userId: { id: userId },
        });
        return await this.favoriteRepo.save(favorite);
      }
      else if (createFavoriteDto.projectType === 'revised') {
        existingFavorite = await this.favoriteRepo.findOne({
          where: {
            revisionProjectGroupId: { id: createFavoriteDto.projectId },
            userId: { id: userId },
          },
        });

        if (existingFavorite) {
          throw new ConflictException('Favorite already exists for this project');
        }

        const favorite = this.favoriteRepo.create({
          revisionProjectGroupId: { id: createFavoriteDto.projectId },
          userId: { id: userId },
        });
        return await this.favoriteRepo.save(favorite);
      }
      else {
        throw new BadRequestException('Invalid project type');
      }
    } catch (error) {
      this.logger.error(`Error creating favorite: ${error.message}`, error.stack);
      throw error;
    }
  }


  async findByUserId(userId: string): Promise<Favorite[]> {
    try {
      return await this.favoriteRepo.find({
        where: { userId: { id: userId } },
        relations: ['projectGroupId', 'revisionProjectGroupId', 'userId'],
        order: { id: 'DESC' },
      });
    } catch (error) {
      this.logger.error(`Error fetching user favorites: ${error.message}`, error.stack);
      throw error;
    }
  }



  async remove(id: string, userId: string): Promise<void> {
    try {
      const favorite = await this.favoriteRepo.findOne({
        where: {
          id,
          userId: { id: userId },
        },
      });
      
      if (!favorite) {
        throw new NotFoundException('Favorite not found');
      }
      
      await this.favoriteRepo.remove(favorite);
    } catch (error) {
      this.logger.error(`Error removing favorite: ${error.message}`, error.stack);
      throw error;
    }
  }


}
