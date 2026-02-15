import { isAIAvailable, estimateTokens, truncateToTokens } from '../../app/utils/ai-client.js';

describe('AI Client', () => {
  it('isAIAvailable returns false before init', () => {
    expect(isAIAvailable()).toBe(false);
  });

  it('estimateTokens returns approximate count', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('')).toBe(0);
  });

  it('truncateToTokens truncates long text', () => {
    const longText = 'a'.repeat(100);
    const result = truncateToTokens(longText, 10); // 10 tokens = 40 chars
    expect(result.length).toBe(40);
    expect(result.endsWith('...')).toBe(true);
  });

  it('truncateToTokens returns text unchanged when under limit', () => {
    const shortText = 'hello';
    expect(truncateToTokens(shortText, 100)).toBe('hello');
  });
});
