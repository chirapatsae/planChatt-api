import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PromptSuggestionsDto } from './dto/prompt-suggestions.dto';

const mockAiService = {
  generateProjectDetail: jest.fn(),
  regenerateField: jest.fn(),
  analyzeProjectForSmartApprove: jest.fn(),
  generatePromptSuggestions: jest.fn(),
};

const fakeReq = { user: { userId: 'user-1' } } as any;

describe('AiController', () => {
  let controller: AiController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [{ provide: AiService, useValue: mockAiService }],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST prompt-suggestions', () => {
    const body: PromptSuggestionsDto = {
      reportFormat: 'STRATEGY_BASED',
      strategyName: 'ยุทธศาสตร์ 1',
    };

    it('returns suggestions array from service (happy path)', async () => {
      mockAiService.generatePromptSuggestions.mockResolvedValue({
        suggestions: ['เน้นการมีส่วนร่วม', 'เพิ่มตัวชี้วัดเชิงคุณภาพ'],
        usage: null,
        cost: 0,
      });

      const result = await controller.promptSuggestions(body, fakeReq);
      expect(result).toEqual({
        suggestions: ['เน้นการมีส่วนร่วม', 'เพิ่มตัวชี้วัดเชิงคุณภาพ'],
      });
      expect(mockAiService.generatePromptSuggestions).toHaveBeenCalledWith(
        body,
      );
    });

    it('returns empty suggestions when service returns empty pool', async () => {
      mockAiService.generatePromptSuggestions.mockResolvedValue({
        suggestions: [],
        usage: null,
        cost: 0,
      });

      const result = await controller.promptSuggestions(body, fakeReq);
      expect(result).toEqual({ suggestions: [] });
    });

    it('throws UnauthorizedException when no user on request', async () => {
      await expect(
        controller.promptSuggestions(body, { user: undefined } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockAiService.generatePromptSuggestions).not.toHaveBeenCalled();
    });
  });
});
