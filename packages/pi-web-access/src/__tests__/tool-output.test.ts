import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  fetchOutput,
  fetchOutputSchema,
  searchOutput,
  searchOutputSchema,
} from '../tool-output.js';

describe('tool-output', () => {
  it('bounds escaped external results and keeps retained source URLs intact', () => {
    const url = 'https://example.com/source';
    const result = searchOutput({
      provider: 'provider',
      query: 'query',
      answer: '\u0000'.repeat(50000),
      results: Array.from({ length: 100 }, () => ({
        title: 'Title',
        url,
        content: '中文\u0000'.repeat(50000),
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((item) => item.url === url)).toBe(true);
    expect(Value.Check(searchOutputSchema, result)).toBe(true);
  });
  it('bounds fetched data without changing the source URL', () => {
    const result = fetchOutput({
      url: 'https://example.com',
      title: 'Title',
      content: '\u0000'.repeat(50000),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.url).toBe('https://example.com');
    expect(result.truncated).toBe(true);
    expect(Value.Check(fetchOutputSchema, result)).toBe(true);
  });
});
