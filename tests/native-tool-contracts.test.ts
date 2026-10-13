import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { callBrowser } = vi.hoisted(() => ({ callBrowser: vi.fn() }));
vi.mock('../packages/pi-browser-use/src/profile.js', () => ({ prepareBrowserProfile: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = async () => {};
    ping = async () => {};
    close = async () => {};
    listTools = async () => ({
      tools: [
        {
          name: 'lighthouse_audit',
          description: 'Lighthouse audit',
          inputSchema: { type: 'object' },
        },
      ],
    });
    callTool = callBrowser;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }));
vi.mock('../packages/pi-web-access/src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadWebToolSettings: () => ({
    search: { provider: 'cloudflare' },
    providers: { cloudflare: { apiKey: 'fixture-key', accountId: 'fixture' } },
  }),
}));
vi.mock('../packages/pi-web-access/src/search.js', () => ({
  search: async () => ({
    provider: 'cloudflare',
    query: 'Pi',
    results: [{ title: 'Pi docs', url: 'https://pi.dev', content: 'Extensions' }],
  }),
}));
import browserExtension from '../packages/pi-browser-use/src/index.js';
import webExtension from '../packages/pi-web-access/src/index.js';

describe('native tool contracts', () => {
  it.each([
    'on',
    'only',
  ] as const)('passes objects to codemode %s and keeps discovery behind tool_call guards', async (mode) => {
    const sdk = await import(
      '../packages/pi-browser-use/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    );
    const cwd = await mkdtemp(join(tmpdir(), 'pi-native-tools-'));
    const calls: string[] = [];
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        sdk.createCodemodeExtension({ models: false, mode }),
        sdk.createToolSearchExtension(),
        browserExtension,
        webExtension,
        (pi: any) => {
          pi.on('tool_call', (event: any) => {
            calls.push(event.toolName);
            if (event.toolName === 'browser_lighthouse_audit')
              return { block: true, reason: 'native guard denied audit' };
          });
        },
      ],
    });
    let session: any;
    try {
      await loader.reload();
      ({ session } = await sdk.createAgentSession({
        cwd,
        agentDir: cwd,
        resourceLoader: loader,
        settingsManager: sdk.SettingsManager.inMemory({
          defaultTools: ['+codemode', '+tool_search'],
        }),
        sessionManager: sdk.SessionManager.inMemory(cwd),
      }));
      await session.bindExtensions({});
      const project = async () =>
        session.agent.transformContext(
          [
            {
              role: 'system',
              content: [],
              toolsAdded: session.agent.state.tools.map(
                ({ name, description, parameters }: any) => ({ name, description, parameters }),
              ),
            },
          ],
          new AbortController().signal,
        );
      const declaredNames = async () =>
        (await project())[0].toolsAdded.map((tool: any) => tool.name);
      expect(await declaredNames()).not.toContain('browser_tools');
      expect(
        session.agent.state.tools.find((tool: any) => tool.name === 'codemode').description,
      ).not.toContain('browser_tools');
      expect(session.systemPrompt).not.toContain('call browser_tools');
      const active = session.getActiveToolNames();
      session.setActiveToolsByName(active.filter((name: string) => name !== 'tool_search'));
      expect(await declaredNames()).toContain('browser_tools');
      expect(session.systemPrompt).toContain('call browser_tools');
      session.setActiveToolsByName(active);
      expect(await declaredNames()).not.toContain('browser_tools');
      expect(session.systemPrompt).not.toContain('call browser_tools');
      const code =
        'text(await searchTools("lighthouse", {namespace: "browser_use"})); const result = await tools.web_search({query: "Pi"}); text({url: result.results[0].url, truncated: result.truncated}); try { await tools.browser_lighthouse_audit({pageId: 1}); } catch(error) { text(String(error)); }';
      session.agent.state.messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'native-test', name: 'codemode', arguments: { code } }],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture',
        stopReason: 'toolUse',
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      const codemode = session.agent.state.tools.find((tool: any) => tool.name === 'codemode');
      const result = await codemode.execute('native-test', { code });
      expect(JSON.stringify(result.content)).toContain('https://pi.dev');
      expect(JSON.stringify(result.content)).toContain('browser_lighthouse_audit');
      expect(JSON.stringify(result.content)).toContain('native guard denied audit');
      expect(calls).toContain('browser_lighthouse_audit');
      expect(callBrowser).not.toHaveBeenCalled();
      const search = session.agent.state.tools.find((tool: any) => tool.name === 'tool_search');
      await search.execute('discover-test', { query: 'lighthouse' });
      expect(session.getActiveToolNames()).toContain('browser_lighthouse_audit');
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
