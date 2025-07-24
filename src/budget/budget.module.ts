import { Module } from '@nestjs/common';
import { BudgetService } from './budget.service';
import { BudgetController } from './budget.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Budget } from './entities/budget.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Budget, ProjectGroup])],
  controllers: [BudgetController],
  providers: [BudgetService],
})
export class BudgetModule {}
