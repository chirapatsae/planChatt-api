import { Test, TestingModule } from '@nestjs/testing';
import { PdfService } from './pdf.service';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import * as path from 'path';

// Mocks for external modules
jest.mock('pdfmake', () => {
  return jest.fn().mockImplementation(() => ({
    createPdfKitDocument: jest.fn(() => mockPdfDoc),
  }));
});

jest.mock('wordcut', () => ({
  init: jest.fn(),
  cut: jest.fn((text) => text),
}));

jest.spyOn(path, 'resolve').mockImplementation((...args) => args.join('/'));

const mockPdfDoc = {
  on: jest.fn(),
  end: jest.fn(),
};

const minimalAmphoe = {
  id: 'amphoe-uuid',
  name: 'Amphoe',
  createAt: new Date(),
  workHistory: [],
  localAdministrativeOrganization: [],
  workHistoryResponsibleAdmins: [],
};
const minimalWorkHistory = {
  id: 'work-history-uuid',
  amphoe: minimalAmphoe,
  localAdministrativeOrganization: {
    id: 'lao-uuid',
    name: 'LAO',
    type: 'type',
    createdAt: new Date(),
    deleteAt: null,
    amphoe: minimalAmphoe,
    workHistory: [],
    originAgencyProjectGroup: [],
  },
  user: {
    id: 'user-uuid',
    citizenId: 'cid',
    citizenIdHash: 'hash',
    prefix: '',
    firstname: '',
    lastname: '',
    isFirstLogin: true,
    createAt: new Date(),
    workHistory: [],
    createdWorkHistory: [],
    updatedWorkHistory: [],
    position: [],
    userActivityLogs: [],
  },
  workStatus: {
    id: 'workstatus-uuid',
    name: 'WorkStatus',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  },
  role: {
    id: 'role-uuid',
    name: 'Role',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  },
  governmentAgencies: {
    id: 'gov-uuid',
    name: 'Gov',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
    responsibleAgencyProjectGroup: [],
  },
  createdAt: new Date(),
  createdBy: undefined,
  deletedAt: undefined,
  updatedAt: new Date(),
  updatedBy: undefined,
  isCurrent: true,
  workHistoryResponsibleAdmins: [],
  budgetPlan: [],
  creatorStrategy: [],
  deletorStrategy: [],
  creatorProjectGroup: [],
  responsibleProjectGroup: [],
  creatorTactic: [],
  deletorTactic: [],
  creatorPlan: [],
  deletorPlan: [],
  creatorTrackingStatus: [],
  deletorTrackingStatus: [],
  creatorStatus: [],
  deletorStatus: [],
};

const mockBudgetPlan = {
  id: 'budget-plan-uuid',
  name: 'Test Budget Plan',
  startYear: 2020,
  endYear: 2022,
  isLatest: true,
  createAt: new Date(),
  deletedAt: undefined, // fix: should be undefined, not null
  createdBy: minimalWorkHistory, // minimal WorkHistory
  projectGroup: [], // minimal array
  budget: [], // minimal array
};

const mockProjects = [
  {
    title: 'Project 1',
    objective: 'Objective 1',
    goal: 'Goal 1',
    indicator: 'Indicator 1',
    expected: 'Expected 1',
    strategy: { name: 'Strategy 1' },
    tactic: { name: 'Tactic 1' },
    plan: { name: 'Plan 1' },
    budgets: [
      { year: 2020, quantity: '1000' },
      { year: 2021, quantity: '2000' },
    ],
    workHistory: {
      localAdministrativeOrganization: { name: 'Org 1' },
    },
  },
];

describe('PdfService', () => {
  let service: PdfService;
  let budgetPlanRepo: jest.Mocked<Repository<BudgetPlan>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PdfService,
        {
          provide: getRepositoryToken(BudgetPlan),
          useValue: {
            findOneBy: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PdfService>(PdfService);
    budgetPlanRepo = module.get(getRepositoryToken(BudgetPlan));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateProjectReport', () => {
    it('should generate a PDF buffer for valid input', async () => {
      budgetPlanRepo.findOneBy.mockResolvedValue({ ...mockBudgetPlan });
      // Simulate PDF doc streaming
      const dataListeners: any[] = [];
      const endListeners: any[] = [];
      const errorListeners: any[] = [];
      mockPdfDoc.on.mockImplementation((event, cb) => {
        if (event === 'data') dataListeners.push(cb);
        if (event === 'end') endListeners.push(cb);
        if (event === 'error') errorListeners.push(cb);
      });
      mockPdfDoc.end.mockImplementation(() => {
        dataListeners.forEach((cb) => cb(Buffer.from('PDFDATA')));
        endListeners.forEach((cb) => cb());
      });

      const result = await service.generateProjectReport(mockProjects);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('PDFDATA');
      expect(budgetPlanRepo.findOneBy).toHaveBeenCalledWith({ isLatest: true });
    });

    it('should throw if no latest BudgetPlan is found', async () => {
      budgetPlanRepo.findOneBy.mockResolvedValue(null);
      await expect(service.generateProjectReport(mockProjects)).rejects.toThrow(
        'BudgetPlan not found',
      );
    });

    it('should throw on repository error (InternalServerErrorException)', async () => {
      budgetPlanRepo.findOneBy.mockRejectedValue(new Error('DB error'));
      await expect(service.generateProjectReport(mockProjects)).rejects.toThrow(
        'DB error',
      );
    });

    it('should throw if PDF generation fails (InternalServerErrorException)', async () => {
      budgetPlanRepo.findOneBy.mockResolvedValue({ ...mockBudgetPlan });
      mockPdfDoc.on.mockImplementation((event, cb) => {
        if (event === 'error') setTimeout(() => cb(new Error('PDF error')), 0);
      });
      mockPdfDoc.end.mockImplementation(() => {
        // Only error event
      });
      await expect(service.generateProjectReport(mockProjects)).rejects.toThrow(
        'PDF error',
      );
    });

    describe('edge cases', () => {
      beforeEach(() => {
        budgetPlanRepo.findOneBy.mockResolvedValue({ ...mockBudgetPlan });
      });

      it('should handle empty projects array', async () => {
        const dataListeners: any[] = [];
        const endListeners: any[] = [];
        mockPdfDoc.on.mockImplementation((event, cb) => {
          if (event === 'data') dataListeners.push(cb);
          if (event === 'end') endListeners.push(cb);
        });
        mockPdfDoc.end.mockImplementation(() => {
          dataListeners.forEach((cb) => cb(Buffer.from('EMPTY')));
          endListeners.forEach((cb) => cb());
        });
        const result = await service.generateProjectReport([]);
        expect(result).toBeInstanceOf(Buffer);
        expect(result.toString()).toBe('EMPTY');
      });

      it('should handle projects with missing/empty fields', async () => {
        const dataListeners: any[] = [];
        const endListeners: any[] = [];
        mockPdfDoc.on.mockImplementation((event, cb) => {
          if (event === 'data') dataListeners.push(cb);
          if (event === 'end') endListeners.push(cb);
        });
        mockPdfDoc.end.mockImplementation(() => {
          dataListeners.forEach((cb) => cb(Buffer.from('MISSING')));
          endListeners.forEach((cb) => cb());
        });
        const projects = [
          { title: '', budgets: [], strategy: null, tactic: null, plan: null },
        ];
        const result = await service.generateProjectReport(projects);
        expect(result).toBeInstanceOf(Buffer);
        expect(result.toString()).toBe('MISSING');
      });

      it('should handle negative, zero, or non-numeric years in budgets', async () => {
        const dataListeners: any[] = [];
        const endListeners: any[] = [];
        mockPdfDoc.on.mockImplementation((event, cb) => {
          if (event === 'data') dataListeners.push(cb);
          if (event === 'end') endListeners.push(cb);
        });
        mockPdfDoc.end.mockImplementation(() => {
          dataListeners.forEach((cb) => cb(Buffer.from('EDGE')));
          endListeners.forEach((cb) => cb());
        });
        const projects = [
          {
            title: 'Edge',
            budgets: [
              { year: 0, quantity: '0' },
              { year: -1, quantity: '-100' },
              { year: 2021, quantity: 'notanumber' },
            ],
            strategy: { name: 'S' },
            tactic: { name: 'T' },
            plan: { name: 'P' },
          },
        ];
        const result = await service.generateProjectReport(projects);
        expect(result).toBeInstanceOf(Buffer);
        expect(result.toString()).toBe('EDGE');
      });
    });
  });
});
