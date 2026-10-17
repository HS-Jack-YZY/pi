import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webFetch } from '../fetch.js';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

const request = vi.fn();
const settings: WebToolSettings = {
  search: { provider: 'deepseek' },
  fetch: { provider: 'deepseek' },
  providers: { deepseek: { apiKey: 'fixture' } },
};
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('DeepSeek Search and Fetch', () => {
  beforeEach(() => {
    request.mockReset();
    vi.stubGlobal('fetch', request);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns ranked sources and summaries without invoking a model', async () => {
    request.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Example',
            url: 'https://example.com',
            summary: 'Long summary',
            snippet: 'Short',
            rerank_score: 2.4,
          },
        ],
      }),
    });
    expect(await search({ query: 'DeepSeek', maxResults: 3 }, settings)).toEqual({
      provider: 'deepseek',
      query: 'DeepSeek',
      results: [
        { title: 'Example', url: 'https://example.com', content: 'Long summary', score: 2.4 },
      ],
    });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(options.headers.Authorization).toBe('Bearer fixture');
    expect(JSON.parse(options.body)).toEqual({ query: 'DeepSeek', count: 3, need_content: false });
  });
  it('fetches Markdown through the configured endpoint and forwards cancellation', async () => {
    request.mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'Page', content: '# Page\nBody' }),
    });
    const controller = new AbortController();
    expect(
      await webFetch(
        { url: 'https://example.com' },
        {
          ...settings,
          timeoutMs: 1000,
          providers: {
            deepseek: {
              apiKey: 'fixture',
              baseUrl: 'https://gateway.example/v1/',
              headers: { 'X-Custom': 'yes' },
            },
          },
        },
        lookup,
        controller.signal,
      ),
    ).toEqual({ url: 'https://example.com', title: 'Page', content: '# Page\nBody' });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://gateway.example/v1/tools/fetch');
    expect(JSON.parse(options.body)).toEqual({ url: 'https://example.com' });
    expect(options.headers['X-Custom']).toBe('yes');
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });

  it('maps domain and date filters to search syntax', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T12:00:00Z'));
    request.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    try {
      const result = await search(
        {
          query: 'Pi',
          includeDomains: ['a.com', 'b.com'],
          excludeDomains: ['c.com'],
          timeRange: 'week',
        },
        settings,
      );
      expect(result.results).toEqual([]);
      expect(JSON.parse(request.mock.calls[0]![1].body).query).toBe(
        'Pi site:a.com OR site:b.com -site:c.com after:2026-10-10',
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('accepts Unicode code points and rejects overlong queries including filters', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    await search({ query: '😀'.repeat(128) }, settings);
    request.mockClear();
    await expect(
      search({ query: 'a'.repeat(128), includeDomains: ['a.com'] }, settings),
    ).rejects.toThrow('1–128');
    await expect(search({ query: '   ' }, settings)).rejects.toThrow('1–128');
    await expect(search({ query: 'Pi', maxResults: 1.5 }, settings)).rejects.toThrow('integer');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'search',
    'fetch',
  ] as const)('sanitizes %s HTTP and network failures', async (operation) => {
    const run = () =>
      operation === 'search'
        ? search({ query: 'Pi' }, settings)
        : webFetch({ url: 'https://example.com' }, settings, lookup);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      request.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'secret-token' });
      await expect(run()).rejects.toThrow(`DeepSeek ${operation} API error 401.`);
      request.mockRejectedValueOnce(new Error('secret-token'));
      await expect(run()).rejects.toThrow(`DeepSeek ${operation} request failed.`);
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
    } finally {
      log.mockRestore();
    }
  });

  it('rejects unsafe fetch URLs before contacting DeepSeek', async () => {
    await expect(webFetch({ url: 'http://127.0.0.1' }, settings, lookup)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects malformed search results and empty fetch bodies', async () => {
    request.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [null] }) });
    await expect(search({ query: 'Pi' }, settings)).rejects.toThrow('invalid response');
    request.mockResolvedValueOnce({ ok: true, json: async () => ({ title: '', content: '' }) });
    await expect(webFetch({ url: 'https://example.com' }, settings, lookup)).rejects.toThrow(
      'no page content',
    );
  });
  it('cancels search on caller abort and configured timeout', async () => {
    request.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const controller = new AbortController();
      const result = search({ query: 'Pi' }, settings, controller.signal);
      controller.abort();
      await expect(result).rejects.toBe(controller.signal.reason);
      await expect(search({ query: 'Pi' }, { ...settings, timeoutMs: 10 })).rejects.toThrow(
        'timeout',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('uses snippets as fallback and caps results at the requested count', async () => {
    request.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'First',
            url: 'https://example.com',
            summary: '',
            snippet: 'Short summary',
            rerank_score: 1.5,
          },
          {
            title: 'Second',
            url: 'https://example.org',
            summary: 'Second summary',
            snippet: '',
            rerank_score: 1,
          },
        ],
      }),
    });
    const result = await search({ query: 'Pi', maxResults: 1 }, settings);
    expect(result.results).toEqual([
      { title: 'First', url: 'https://example.com', content: 'Short summary', score: 1.5 },
    ]);
  });
  it('uses the source URL when a fetch response has a malformed title', async () => {
    request.mockResolvedValue({
      ok: true,
      json: async () => ({ title: { invalid: true }, content: 'Body' }),
    });
    expect(await webFetch({ url: 'https://example.com' }, settings, lookup)).toEqual({
      url: 'https://example.com',
      title: 'https://example.com',
      content: 'Body',
    });
  });
});
