import { Test, TestingModule } from '@nestjs/testing';
import { PdfController } from './pdf.controller';
import { PdfService } from './pdf.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';


describe('PdfController', () => {
  let controller: PdfController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PdfController],
      providers: [
        PdfService,
        {
          provide: getRepositoryToken(BudgetPlan),
          useValue: { findOneBy: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<PdfController>(PdfController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
