import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PdfController } from './pdf.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { PdfDraftDocument } from './entities/pdf-draft-document.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BudgetPlan, ProjectGroup, PdfDraftDocument, User])],
  controllers: [PdfController],
  providers: [PdfService],
})
export class PdfModule {}
