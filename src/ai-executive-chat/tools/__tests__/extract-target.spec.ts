/**
 * BE-W45-01 — `extractTargetFromToolResult` unit tests.
 *
 * Covers the 10 canonical cases from BE-W45-01 §10:
 *   1-3. 3 eligible tools, items.length === 1 → capture
 *   4-6. 3 eligible tools, items.length === 0 → null
 *   7-9. 3 eligible tools, items.length === 2 → null
 *   10.  Non-registered tool → null
 *   11.  Zero-UUID rejected → null
 *   12.  Malformed payload (no `items` key) → null (fail-silent)
 *
 * (Cases 11 and 12 are bundled into the same "defensive" group as
 * expansions of the core 10; the § "10 cases" refers to functional
 * coverage categories, not literal test count.)
 *
 * CLAUDE.md §17.2 — extractor MUST NEVER throw; fail-silent is correct.
 */

import {
  extractTargetFromToolResult,
  TARGET_EXTRACTION_REGISTRY,
} from '../extract-target';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const ELIGIBLE_TOOLS = [
  'searchProjectsByKeyword',
  'detectWorkflowAgingProjects',
  'highlightBudgetOutliers',
] as const;

describe('BE-W45-01 / extractTargetFromToolResult', () => {
  describe('captures when items.length === 1 (3 eligible tools)', () => {
    it.each(ELIGIBLE_TOOLS)(
      '%s: single item → { targetId, targetKind: project-group }',
      (toolName) => {
        const result = {
          items: [{ projectId: UUID_A, name: 'some project' }],
          asOf: '2026-04-23T00:00:00.000Z',
        };
        expect(extractTargetFromToolResult(toolName, result)).toEqual({
          targetId: UUID_A,
          targetKind: 'project-group',
        });
      },
    );
  });

  describe('returns null when items.length === 0 (3 eligible tools)', () => {
    it.each(ELIGIBLE_TOOLS)('%s: empty items → null', (toolName) => {
      const result = { items: [], asOf: '2026-04-23T00:00:00.000Z' };
      expect(extractTargetFromToolResult(toolName, result)).toBeNull();
    });
  });

  describe('returns null when items.length === 2 (3 eligible tools)', () => {
    it.each(ELIGIBLE_TOOLS)('%s: two items → null', (toolName) => {
      const result = {
        items: [
          { projectId: UUID_A, name: 'first' },
          { projectId: UUID_B, name: 'second' },
        ],
        asOf: '2026-04-23T00:00:00.000Z',
      };
      expect(extractTargetFromToolResult(toolName, result)).toBeNull();
    });
  });

  it('returns null for a non-registered tool', () => {
    const result = {
      items: [{ projectId: UUID_A, name: 'would-have-been-captured' }],
    };
    // `listActivePlans` is a real tool but NOT in the registry.
    expect(extractTargetFromToolResult('listActivePlans', result)).toBeNull();
    // An entirely unknown name is also null.
    expect(
      extractTargetFromToolResult('totallyUnknownTool', result),
    ).toBeNull();
  });

  it('rejects the zero-UUID even if a tool result returns it', () => {
    const result = {
      items: [{ projectId: ZERO_UUID, name: 'sentinel-resurrection-attempt' }],
    };
    // All 3 eligible tools must refuse the sentinel.
    for (const toolName of ELIGIBLE_TOOLS) {
      expect(extractTargetFromToolResult(toolName, result)).toBeNull();
    }
  });

  it('returns null for malformed payloads (fail-silent)', () => {
    // Missing `items` key entirely.
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', {
        asOf: '2026-04-23T00:00:00.000Z',
      }),
    ).toBeNull();
    // `items` present but not an array.
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', {
        items: 'not-an-array',
      }),
    ).toBeNull();
    // Single item but `projectId` missing.
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', {
        items: [{ name: 'no-id-field' }],
      }),
    ).toBeNull();
    // Single item but `projectId` is not a UUID.
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', {
        items: [{ projectId: 'not-a-uuid' }],
      }),
    ).toBeNull();
    // Top-level result is not an object.
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', null),
    ).toBeNull();
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', 'string-result'),
    ).toBeNull();
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', undefined),
    ).toBeNull();
    // Single item is not an object.
    expect(
      extractTargetFromToolResult('searchProjectsByKeyword', {
        items: ['scalar-item'],
      }),
    ).toBeNull();
  });

  it('registry is frozen and contains exactly the 3 Wave 45 tools', () => {
    // Defensive: guarantees future drift (e.g. silently adding a tool)
    // is caught by CI. Adding a new extractable tool requires touching
    // this test too, which is the desired review surface.
    expect(Object.isFrozen(TARGET_EXTRACTION_REGISTRY)).toBe(true);
    expect(Object.keys(TARGET_EXTRACTION_REGISTRY).sort()).toEqual(
      [...ELIGIBLE_TOOLS].sort(),
    );
  });
});
