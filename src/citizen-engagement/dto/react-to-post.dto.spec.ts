import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ReactToPostDto } from './react-to-post.dto';

/**
 * W-S1 — `ReactToPostDto` validation. The optional `reactionType` MUST be one of
 * the 4 FROZEN keys; anything else is rejected (400 at the controller). A
 * missing value is allowed (service defaults to `like`).
 */
describe('ReactToPostDto (W-S1)', () => {
  async function errorsFor(payload: unknown) {
    const dto = plainToInstance(ReactToPostDto, payload);
    return validate(dto);
  }

  it.each(['like', 'love', 'support', 'insightful'])(
    'accepts the FROZEN key "%s"',
    async (reactionType) => {
      expect(await errorsFor({ reactionType })).toHaveLength(0);
    },
  );

  it('accepts an empty body (reactionType omitted → service defaults to like)', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it.each(['heart', 'angry', 'LIKE', '', 'dislike'])(
    'rejects the off-set value "%s"',
    async (reactionType) => {
      const errors = await errorsFor({ reactionType });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('reactionType');
    },
  );
});
