import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PdfController } from './pdf.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { PdfDraftDocument } from './entities/pdf-draft-document.entity';
import { PdfApprovedDocument } from './entities/pdf-approved-document.entity';
import { PdfInAuthorityDocument } from './entities/pdf-in-authority-document.entity';
import { PdfOutAuthorityDocument } from './entities/pdf-out-authority-document.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BudgetPlan, ProjectGroup, PdfDraftDocument, PdfApprovedDocument, PdfInAuthorityDocument, PdfOutAuthorityDocument, User])],
  controllers: [PdfController],
  providers: [PdfService],
})
export class PdfModule {}
