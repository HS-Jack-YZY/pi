import { beforeEach, describe, expect, it, test, vi } from 'vitest';

const mockCreateMessage = vi.fn();
const mockReplyMessage = vi.fn();
const mockChatGet = vi.fn();
const mockRequest = vi.fn();
const mockChannelOn = vi.fn();
const mockChannelConnect = vi.fn();
const mockChannelDisconnect = vi.fn();
let channelHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: {
    SelfBuild: 0,
    ISV: 1,
  },
  Domain: {
    Feishu: 0,
    Lark: 1,
  },
  LoggerLevel: {
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
  },
  Client: class MockClient {
    im = {
      message: {
        create: mockCreateMessage,
        reply: mockReplyMessage,
      },
      chat: {
        get: mockChatGet,
      },
    };
    request = mockRequest;
  },
  EventDispatcher: class MockEventDispatcher {
    register = vi.fn(() => this);
  },
  adaptDefault: vi.fn(() => vi.fn()),
  createLarkChannel: vi.fn(() => ({
    on: mockChannelOn.mockImplementation(
      (name: string, handler: (...args: unknown[]) => unknown) => {
        channelHandlers.set(name, handler);
      },
    ),
    connect: mockChannelConnect,
    disconnect: mockChannelDisconnect,
  })),
}));

const { createFeishuAdapter } = await import('../adapters/feishu.js');
const lark = await import('@larksuiteoapi/node-sdk');

describe('Feishu adapter', () => {
  beforeEach(() => {
    mockCreateMessage.mockReset();
    mockReplyMessage.mockReset();
    mockChatGet.mockReset();
    mockRequest.mockReset();
    mockChannelOn.mockReset();
    mockChannelConnect.mockReset();
    mockChannelDisconnect.mockReset();
    channelHandlers = new Map();
    mockCreateMessage.mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
    mockReplyMessage.mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } });
    mockChatGet.mockResolvedValue({ code: 0, data: { chat: { name: '测试群' } } });
    mockRequest.mockResolvedValue({ data: { code: 0 } });
  });

  it('sends Markdown replies as post/md without rewriting tables', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '**结果**\n\n| 股票 | bonus |\n| :--- | ---: |\n| 中兴 600851 | +5.66 |',
      metadata: { messageId: 'om_inbound', threadId: 'omt_thread' },
    });
    expect(mockReplyMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_inbound' },
      data: {
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                {
                  tag: 'md',
                  text: '**结果**\n\n| 股票 | bonus |\n| :--- | ---: |\n| 中兴 600851 | +5.66 |',
                },
              ],
            ],
          },
        }),
        reply_in_thread: true,
      },
    });
  });

  it('renders sourced messages sent directly to an explicit recipient', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'open_id:ou_user',
      source: 'agent',
      text: '# Title\n**bold**',
    });
    expect(mockCreateMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_user',
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: 'md', text: '[agent]\n# Title\n**bold**' }]] },
        }),
      },
    });
  });

  it.each([false, true])('falls back on logical post rejection (reply=%s)', async (reply) => {
    const log = vi.fn();
    const request = reply ? mockReplyMessage : mockCreateMessage;
    request.mockResolvedValueOnce({ code: 230099, msg: 'untrusted response' });
    const adapter = createFeishuAdapter(
      { type: 'feishu', appId: 'id', appSecret: 'secret', eventMode: 'off', replyInThread: false },
      { log },
    );
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '# Title\n**bold**\n| name | score |\n| --- | --- |\n| 张三 | 5 |',
      metadata: reply ? { messageId: 'om_inbound', threadId: 'omt_thread' } : {},
    });
    const data = request.mock.calls[1]![0].data;
    expect(data.msg_type).toBe('text');
    expect(JSON.parse(data.content)).toEqual({ text: 'Title\nbold\nname：张三\nscore：5' });
    if (reply) expect(data.reply_in_thread).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith('feishu-render-fallback', { code: 230099 }, 'WARN');
  });

  it('reports failure when both post and text are rejected without leaking provider messages', async () => {
    mockCreateMessage.mockResolvedValue({ code: 230001, msg: 'secret response' });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await expect(
      adapter.send?.({ adapter: 'feishu', recipient: 'oc_chat', text: '**result**' }),
    ).rejects.toThrow('Feishu send failed (code 230001)');
    expect(mockCreateMessage).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous network failure that may already have delivered the post', async () => {
    mockCreateMessage.mockRejectedValue(new Error('private network error'));
    const log = vi.fn();
    const adapter = createFeishuAdapter(
      { type: 'feishu', appId: 'id', appSecret: 'secret', eventMode: 'off' },
      { log },
    );
    await expect(
      adapter.send?.({ adapter: 'feishu', recipient: 'oc_chat', text: 'hello' }),
    ).rejects.toThrow('Feishu message request failed');
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('feishu-send-failed', {}, 'ERROR');
  });

  it('keeps long Markdown in post/md without an eager text downgrade', async () => {
    const text = `**内容**\n${'中'.repeat(10000)}`;
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({ adapter: 'feishu', recipient: 'oc_chat', text });
    expect(mockCreateMessage).toHaveBeenCalledExactlyOnceWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'post',
        content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } }),
      },
    });
  });

  it.each([
    ['a | b\n:---: | ---:\nx | y\nz |', 'a：x\nb：y\n\na：z\nb：'],
    ['| a | b |\n| --- | --- |\n| `x|y` | z |', 'a：x|y\nb：z'],
    ['| a | b |\n| --- | --- |\n| x\\|y | z |', 'a：x|y\nb：z'],
    ['| a |\n| --- |\n| 中 |', 'a：中'],
    ['| a | b |\n| --- | --- |\n| x | y | z |', 'a：x\nb：y\n3：z'],
  ])('expands tables only after post rejection: %s', async (text, expected) => {
    mockCreateMessage.mockResolvedValueOnce({ code: 230099 });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({ adapter: 'feishu', recipient: 'oc_chat', text });
    expect(mockCreateMessage.mock.calls[0]![0].data.msg_type).toBe('post');
    expect(JSON.parse(mockCreateMessage.mock.calls[0]![0].data.content)).toEqual({
      zh_cn: { content: [[{ tag: 'md', text }]] },
    });
    expect(JSON.parse(mockCreateMessage.mock.calls[1]![0].data.content)).toEqual({
      text: expected,
    });
  });

  it.each([
    ['前文\n```ts\nconst x = 1;\n```\n后文', ['前文', '```ts\nconst x = 1;\n```', '后文']],
    [
      '前文\n~~~text\n| a | b |\n| --- | --- |\n~~~\n后文',
      ['前文', '~~~text\n| a | b |\n| --- | --- |\n~~~', '后文'],
    ],
    [
      '前文\n````\n```\nnot closed yet\n````\n后文',
      ['前文', '````\n```\nnot closed yet\n````', '后文'],
    ],
    ['前文\n```ts\nconst x = 1;', ['前文', '```ts\nconst x = 1;']],
    ['前文\n```inline```\n后文', ['前文\n```inline```\n后文']],
  ])('isolates fenced code without losing trailing prose: %s', async (text, segments) => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({ adapter: 'feishu', recipient: 'oc_chat', text });
    const data = mockCreateMessage.mock.calls[0]![0].data;
    expect(data.msg_type).toBe('post');
    const post = JSON.parse(data.content);
    expect(post.zh_cn.content.map((row: { tag: string; text: string }[]) => row[0]!.text)).toEqual(
      segments,
    );
    expect(post.zh_cn.content.flat().every((item: { tag: string }) => item.tag === 'md')).toBe(
      true,
    );
  });

  it('keeps ordinary messages as verbatim text by default', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '收到',
      source: 'agent',
    });
    expect(mockCreateMessage).toHaveBeenCalledExactlyOnceWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'text',
        content: JSON.stringify({ text: '[agent]\n收到' }),
      },
    });
  });

  it('keeps code intact when falling back to plain text', async () => {
    mockCreateMessage.mockResolvedValueOnce({ code: 230099 });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '**result**\n```\n# comment **literal**\n| a | b |\n| --- | --- |\n```',
    });
    expect(JSON.parse(mockCreateMessage.mock.calls[1]![0].data.content)).toEqual({
      text: 'result\n# comment **literal**\n| a | b |\n| --- | --- |',
    });
  });

  it('preserves literal inline code in readable text fallback', async () => {
    mockCreateMessage.mockResolvedValueOnce({ code: 230099 });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '**Result**: `obj.__dict__` and `a**b**c` and `[x](y)`',
    });
    expect(JSON.parse(mockCreateMessage.mock.calls[1]![0].data.content)).toEqual({
      text: 'Result: obj.__dict__ and a**b**c and [x](y)',
    });
  });

  it('treats unmatched backticks in table cells as literal data', async () => {
    mockCreateMessage.mockResolvedValueOnce({ code: 230099 });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '| a | b |\n| --- | --- |\n| x` | y |',
    });
    expect(JSON.parse(mockCreateMessage.mock.calls[1]![0].data.content)).toEqual({
      text: 'a：x`\nb：y',
    });
  });

  it.each([false, true])('falls back on explicit HTTP post rejection (reply=%s)', async (reply) => {
    const request = reply ? mockReplyMessage : mockCreateMessage;
    request.mockRejectedValueOnce({
      response: { status: 400, data: { code: 230099, msg: 'private provider response' } },
    });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: '**result**',
      metadata: reply ? { messageId: 'om_inbound' } : {},
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0].data.msg_type).toBe('text');
  });

  it.each([
    { status: 500, data: { code: 230099 } },
    { status: 400, data: { code: 0 } },
    { status: 400, data: { code: '230099' } },
    { status: 400, data: 'private response' },
  ])('does not retry ambiguous HTTP failures: %j', async (response) => {
    mockCreateMessage.mockRejectedValueOnce({ response });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await expect(
      adapter.send?.({ adapter: 'feishu', recipient: 'oc_chat', text: '**result**' }),
    ).rejects.toThrow('Feishu message request failed');
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
  });

  it('does not begin a send after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await expect(
      adapter.send?.(
        { adapter: 'feishu', recipient: 'oc_chat', text: '**result**' },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('does not start the fallback when cancelled during the post request', async () => {
    const controller = new AbortController();
    mockCreateMessage.mockImplementationOnce(async () => {
      controller.abort();
      return { code: 230099 };
    });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await expect(
      adapter.send?.(
        { adapter: 'feishu', recipient: 'oc_chat', text: '**result**' },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves intraword underscores and escaped punctuation in fallback text', async () => {
    mockCreateMessage.mockResolvedValueOnce({ code: 230099 });
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'id',
      appSecret: 'secret',
      eventMode: 'off',
    });
    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'foo__bar__baz and **bold** and __bold__ and \\**literal** and \\[x](y)',
    });
    expect(JSON.parse(mockCreateMessage.mock.calls[1]![0].data.content)).toEqual({
      text: 'foo__bar__baz and bold and bold and **literal** and [x](y)',
    });
  });

  test('sends a text message with official SDK Client.im.message.create', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
      renderMode: 'text',
    });

    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'hello',
      source: 'test',
    });

    expect(mockCreateMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'text',
        content: JSON.stringify({ text: '[test]\nhello' }),
      },
    });
  });

  test('uses explicit receive id prefix when provided', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
      renderMode: 'text',
    });

    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'open_id:ou_user',
      text: 'hello',
    });

    expect(mockCreateMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_user',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    });
  });

  test('replies to the original message when bridge metadata carries messageId', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
      renderMode: 'text',
    });

    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'agent reply',
      metadata: {
        messageId: 'om_inbound',
        threadId: 'omt_thread',
      },
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockReplyMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_inbound' },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: 'agent reply' }),
        reply_in_thread: true,
      },
    });
  });

  test('connects the SDK websocket channel and emits accepted incoming messages', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
      allowedChatIds: ['oc_allowed'],
    });
    const onMessage = vi.fn();

    await adapter.start?.(onMessage);

    expect(lark.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'cli_xxx',
        appSecret: 'secret',
        transport: 'websocket',
        policy: expect.objectContaining({
          requireMention: true,
          groupAllowlist: ['oc_allowed'],
        }),
      }),
    );
    expect(mockChannelConnect).toHaveBeenCalledTimes(1);

    channelHandlers.get('message')?.({
      messageId: 'om_1',
      chatId: 'oc_allowed',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'Ada',
      content: 'ping',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 1,
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        adapter: 'feishu',
        sender: 'oc_allowed',
        text: 'ping',
        metadata: expect.objectContaining({
          messageId: 'om_1',
          chatId: 'oc_allowed',
          chatName: '测试群',
          chatType: 'group',
          senderId: 'ou_user',
        }),
      });
    });
    expect(mockRequest).toHaveBeenCalledWith({
      url: '/open-apis/im/v1/messages/om_1/reactions',
      method: 'POST',
      data: {
        reaction_type: {
          emoji_type: 'OK',
        },
      },
    });
  });

  test('supports disabling the websocket acknowledgement reaction', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
      ackReactionEmoji: false,
    });
    const onMessage = vi.fn();

    await adapter.start?.(onMessage);
    channelHandlers.get('message')?.({
      messageId: 'om_1',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      content: 'ping',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 1,
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalled();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects HTTP mode without event authentication', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'http',
      incoming: { port: 0 },
    });

    await expect(adapter.start?.(vi.fn())).rejects.toThrow(
      'Feishu HTTP mode requires encryptKey for event signature verification',
    );
  });

  it('rejects HTTP mode with only a verification token', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'http',
      verificationToken: 'verify-me',
      incoming: { port: 0 },
    });

    await expect(adapter.start?.(vi.fn())).rejects.toThrow(
      'Feishu HTTP mode requires encryptKey for event signature verification',
    );
  });

  it('allows signed HTTP mode and binds to loopback by default', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'http',
      encryptKey: 'encrypt-me',
      incoming: { port: 0 },
    });

    await adapter.start?.(vi.fn());
    await adapter.stop?.();

    expect(lark.adaptDefault).toHaveBeenCalledWith('/feishu/events', expect.anything(), {
      autoChallenge: true,
    });
  });

  test('strips a leading bot mention before forwarding websocket messages', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
      respondToMentionsOnly: true,
    });
    const onMessage = vi.fn();

    await adapter.start?.(onMessage);
    channelHandlers.get('message')?.({
      messageId: 'om_1',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'Ada',
      content: '@AAA建材猫总 你是什么模型',
      rawContentType: 'text',
      resources: [],
      mentions: [
        {
          key: '@_user_1',
          name: 'AAA建材猫总',
          isBot: true,
        },
      ],
      mentionAll: false,
      mentionedBot: true,
      createTime: 1,
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '你是什么模型',
        }),
      );
    });
  });

  test('filters group websocket messages that do not mention the bot', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
      respondToMentionsOnly: true,
    });
    const onMessage = vi.fn();

    await adapter.start?.(onMessage);
    channelHandlers.get('message')?.({
      messageId: 'om_1',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      content: 'ignored',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
