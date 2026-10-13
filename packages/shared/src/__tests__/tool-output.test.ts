import { describe, expect, it } from 'vitest';
import { boundStructuredContent } from '../tool-output.js';

describe('boundStructuredContent', () => {
  it('bounds complete records without changing identifiers or the source data', () => {
    const records = Array.from({ length: 200 }, (_, i) => ({
      id: `issue-${i}`,
      title: '中'.repeat(300),
    }));
    const result = boundStructuredContent({ issues: records, total: 200 });
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(200);
    expect(result.issues).toContainEqual(records[0]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12 * 1024);
    expect(records).toHaveLength(200);
  });

  it('keeps oversized records addressable without clipped content', () => {
    const task = { id: 'task-1', enabled: true, prompt: 'x'.repeat(13_000) };
    const created = boundStructuredContent({ task });
    expect(created).toHaveProperty('task.id', 'task-1');
    expect(created).toHaveProperty('task.enabled', true);
    expect(created).toHaveProperty('task.truncated', true);
    expect(created).not.toHaveProperty('task.prompt');
    expect(created).not.toHaveProperty('error');
    const listed = boundStructuredContent({ tasks: [task], total: 1 });
    expect(listed).toHaveProperty('tasks.0.id', 'task-1');
    expect(listed.truncated).toBe(true);
  });

  it('preserves an earlier truncation flag', () => {
    expect(boundStructuredContent({ memories: [], truncated: true }).truncated).toBe(true);
  });

  it('reports an oversized scalar rather than corrupting a path or identifier', () => {
    const result = boundStructuredContent({ path: 'x'.repeat(20_000) });
    expect(result).toHaveProperty('error');
    expect(result).not.toHaveProperty('path');
  });
});
