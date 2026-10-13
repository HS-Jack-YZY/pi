import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { formatToolResultText } from '../index.js';
import { imageOutput, imageOutputSchema } from '../tool-output.js';

describe('tool-output', () => {
  it.each([
    '',
    'Intro\n',
  ])('retains prefixes of long metadata and revised prompts with %j heading', (heading) => {
    const result = imageOutput({
      model: 'model '.repeat(100),
      provider: 'provider '.repeat(100),
      images: [
        {
          path: '/tmp/image.png',
          mimeType: 'image/png',
          revisedPrompt: heading + '中文🙂'.repeat(1000),
        },
      ],
    });
    expect(result.model).toMatch(/^model /);
    expect(result.provider).toMatch(/^provider /);
    expect(result.images[0]!.revisedPrompt).toContain('中文🙂');
    expect(Buffer.from(result.images[0]!.revisedPrompt!).toString('utf8')).toBe(
      result.images[0]!.revisedPrompt,
    );
    expect(result.truncated).toBe(true);
  });

  it('bounds provider prompts while preserving saved image paths and total count', () => {
    const result = imageOutput({
      model: 'image-model',
      provider: 'provider',
      images: [
        { path: '/tmp/image.png', mimeType: 'image/png', revisedPrompt: '\u0000'.repeat(50000) },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.images[0]?.path).toBe('/tmp/image.png');
    expect(result.totalImages).toBe(1);
    expect(result.truncated).toBe(true);
    expect(Value.Check(imageOutputSchema, result)).toBe(true);
  });
  it('bounds the combined text, details, and structured payload', () => {
    const result = imageOutput({
      model: 'm'.repeat(50000),
      provider: 'provider',
      images: Array.from({ length: 100 }, (_, index) => ({
        path: `/tmp/${'图'.repeat(200)}-${index}.png`,
        mimeType: 'image/png',
      })),
    });
    const toolResult = {
      content: [{ type: 'text', text: formatToolResultText(result) }],
      details: result,
      structuredContent: result,
    };
    expect(Buffer.byteLength(JSON.stringify(toolResult))).toBeLessThan(50 * 1024);
    expect(result.totalImages).toBe(100);
    expect(result.truncated).toBe(true);
  });
});
