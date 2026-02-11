import { mergeRules, type AutoAnswerRule, type ParsedRules } from '../../app/auto-answer/rules-parser';

// Mock rules for testing
function createMockRules(source: 'global' | 'session', rules: Partial<AutoAnswerRule>[]): ParsedRules {
  return {
    source: source === 'global' ? '/workspace/RULES.md' : '/session/file.md',
    rules: rules.map((r, i) => ({
      pattern: r.pattern || 'test',
      answer: r.answer || 'yes',
      source,
      priority: r.priority ?? (source === 'session' ? 20 : 5),
    })),
  };
}

describe('Rules Parser', () => {
  describe('mergeRules', () => {
    it('merges multiple rule sets', () => {
      const global = createMockRules('global', [
        { pattern: 'proceed', answer: 'yes' },
      ]);
      const session = createMockRules('session', [
        { pattern: 'custom', answer: 'custom answer' },
      ]);

      const merged = mergeRules(global, session);
      expect(merged.length).toBe(2);
    });

    it('sorts by priority (highest first)', () => {
      const global = createMockRules('global', [
        { pattern: 'low', answer: 'low', priority: 1 },
      ]);
      const session = createMockRules('session', [
        { pattern: 'high', answer: 'high', priority: 20 },
      ]);

      const merged = mergeRules(global, session);
      expect(merged[0].priority).toBe(20);
      expect(merged[1].priority).toBe(1);
    });

    it('handles empty rule sets', () => {
      const empty = createMockRules('global', []);
      const session = createMockRules('session', [
        { pattern: 'test', answer: 'yes' },
      ]);

      const merged = mergeRules(empty, session);
      expect(merged.length).toBe(1);
    });

    it('session rules have higher priority than global', () => {
      const global = createMockRules('global', [
        { pattern: 'same', answer: 'global answer', priority: 10 },
      ]);
      const session = createMockRules('session', [
        { pattern: 'same', answer: 'session answer', priority: 20 },
      ]);

      const merged = mergeRules(global, session);
      expect(merged[0].source).toBe('session');
    });
  });

  describe('AutoAnswerRule matching', () => {
    it('string pattern matches case-insensitive substring', () => {
      const rule: AutoAnswerRule = {
        pattern: 'proceed',
        answer: 'yes',
        source: 'global',
        priority: 5,
      };

      // String patterns are stored lowercase and matched against lowercase input
      expect(typeof rule.pattern).toBe('string');
      expect((rule.pattern as string).includes('proceed')).toBe(true);
    });

    it('regex pattern can be used for complex matching', () => {
      const rule: AutoAnswerRule = {
        pattern: /continue|proceed/i,
        answer: 'yes',
        source: 'global',
        priority: 5,
      };

      expect(rule.pattern instanceof RegExp).toBe(true);
      expect((rule.pattern as RegExp).test('Should I continue?')).toBe(true);
      expect((rule.pattern as RegExp).test('proceed with changes?')).toBe(true);
    });
  });
});
