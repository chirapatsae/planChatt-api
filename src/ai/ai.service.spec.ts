import { InternalServerErrorException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from './ai.service';
import { RegenerateFieldDto } from './dto/generate-project.dto';

const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn(),
    },
  },
};

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => mockOpenAI),
}));

const validGenerateArgs = {
  strategy: 'กลยุทธ์',
  tactic: 'ยุทธศาสตร์',
  plan: 'แผนงาน',
  userPrompt: 'รายละเอียดเพิ่มเติม',
};

const validRegenerateDto: RegenerateFieldDto = {
  strategy: 'กลยุทธ์',
  tactic: 'ยุทธศาสตร์',
  plan: 'แผนงาน',
  currentProjectData: {
    title: 'ชื่อโครงการ',
    objective: 'วัตถุประสงค์',
    goal: 'เป้าหมาย',
    expected: 'ผลที่คาดหวัง',
    indicator: 'ตัวชี้วัด',
  },
  fieldToRegenerate: 'title',
  modificationPrompt: 'ขอแบบสั้นลง',
};

describe('AiService', () => {
  let service: AiService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [AiService],
    }).compile();
    service = module.get<AiService>(AiService);
  });

  describe('generateProjectDetail', () => {
    it('should return content on success', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'AI generated content' } }],
      });
      const result = await service.generateProjectDetail(
        validGenerateArgs.strategy,
        validGenerateArgs.tactic,
        validGenerateArgs.plan,
        validGenerateArgs.userPrompt,
      );
      expect(result).toBe('AI generated content');
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException on OpenAI error', async () => {
      mockOpenAI.chat.completions.create.mockRejectedValue(
        new Error('OpenAI error'),
      );
      await expect(
        service.generateProjectDetail(
          validGenerateArgs.strategy,
          validGenerateArgs.tactic,
          validGenerateArgs.plan,
          validGenerateArgs.userPrompt,
        ),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should handle edge case: empty userPrompt', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'AI content for empty prompt' } }],
      });
      const result = await service.generateProjectDetail(
        validGenerateArgs.strategy,
        validGenerateArgs.tactic,
        validGenerateArgs.plan,
        '',
      );
      expect(result).toBe('AI content for empty prompt');
    });

    it('should handle edge case: missing userPrompt', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'AI content for missing prompt' } }],
      });
      const result = await service.generateProjectDetail(
        validGenerateArgs.strategy,
        validGenerateArgs.tactic,
        validGenerateArgs.plan,
      );
      expect(result).toBe('AI content for missing prompt');
    });

    it('should handle edge case: empty strings for required fields', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'AI content for empty fields' } }],
      });
      const result = await service.generateProjectDetail('', '', '', '');
      expect(result).toBe('AI content for empty fields');
    });
  });

  describe('regenerateField', () => {
    it('should return regenerated content on success', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'Regenerated content' } }],
      });
      const result = await service.regenerateField(validRegenerateDto);
      expect(result).toBe('Regenerated content');
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException on OpenAI error', async () => {
      mockOpenAI.chat.completions.create.mockRejectedValue(
        new Error('OpenAI error'),
      );
      await expect(service.regenerateField(validRegenerateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException if AI response is invalid', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: {} }],
      });
      await expect(service.regenerateField(validRegenerateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge case: empty fieldToRegenerate', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'Edge case: empty field' } }],
      });
      const dto = { ...validRegenerateDto, fieldToRegenerate: '' };
      const result = await service.regenerateField(dto);
      expect(result).toBe('Edge case: empty field');
    });

    it('should handle edge case: missing currentProjectData fields', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'Edge case: missing fields' } }],
      });
      const dto = {
        ...validRegenerateDto,
        currentProjectData: {},
      };
      const result = await service.regenerateField(dto);
      expect(result).toBe('Edge case: missing fields');
    });

    it('should handle edge case: empty modificationPrompt', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [
          { message: { content: 'Edge case: empty modificationPrompt' } },
        ],
      });
      const dto = { ...validRegenerateDto, modificationPrompt: '' };
      const result = await service.regenerateField(dto);
      expect(result).toBe('Edge case: empty modificationPrompt');
    });
  });
});
