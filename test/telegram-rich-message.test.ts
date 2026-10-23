import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Api, GrammyError } from 'grammy'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import {
  sendRichMarkdown,
  type RichMessageContent,
} from '../src/lib/telegram/send-rich-message.js'

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}))
afterEach(() => vi.clearAllMocks())

test.each([
  ['headings', '# Heading\n\n## Subheading\n\nParagraph'],
  ['emphasis', '**bold** and *italic* and ~~struck~~'],
  ['nested formatting', '**bold with _italic_ inside**'],
  ['inline code', 'Use `file_name` and `2 * 3 < 8`'],
  [
    'code fences',
    '```ts\nconst file_name = "**literal**";\n\n// <tag> & value\n```',
  ],
  ['tables', '| Model | Price |\n| --- | ---: |\n| A | $10 |\n| B | $20 |'],
  ['links', '[docs with _words_](https://example.com/?a=1&b=2)'],
  ['lists', '- First\n- Second\n\n1. One\n2. Two'],
  ['quotes', '> A quote\n> with **bold** text'],
  [
    'punctuation',
    'C++ C# .NET @scope/package: 2 * 3 * 4; x < y & z; C:\\path\\file',
  ],
  ['emoji', '👩🏽‍💻 e\u0301 **🚀**'],
  ['unclosed Markdown', '**An unfinished thought\n\n```ts\nconst x = 1;'],
] as const)(
  'passes %s unchanged to native rich Markdown',
  async (_label, markdown) => {
    const send = vi.fn(async (_content: RichMessageContent) => undefined)

    await sendRichMarkdown(send, markdown)

    expect(send).toHaveBeenCalledExactlyOnceWith({ markdown })
  }
)

test.each([4096, 4097, 32767, 32768])(
  'uses one native message for %i characters',
  async (length) => {
    const markdown = 'x'.repeat(length)
    const send = vi.fn(async (_content: RichMessageContent) => undefined)

    await sendRichMarkdown(send, markdown)

    expect(send).toHaveBeenCalledExactlyOnceWith({ markdown })
  }
)

test('splits a long answer between complete Markdown paragraphs in order', async () => {
  const paragraph = '**A useful explanation with _nested_ formatting.**\n\n'
  const markdown = paragraph.repeat(1800)
  const send = vi.fn(async (_content: RichMessageContent) => undefined)

  await sendRichMarkdown(send, markdown)

  expect(send.mock.calls.length).toBeGreaterThan(1)
  const parts = send.mock.calls.map(([content]) => content.markdown ?? '')
  expect(parts.join('')).toBe(markdown)
  expect(
    parts.every((part) => part.length <= 32768 && part.endsWith('\n\n'))
  ).toBe(true)
  expect(parts.every((part) => part.startsWith('**A useful'))).toBe(true)
})

test.each(['```ts', '~~~~ts', '````ts'] as const)(
  'keeps a %s code block intact despite blank lines',
  async (opener) => {
    const prefix = 'p'.repeat(32000) + '\n\n'
    const closer = opener.replace('ts', '')
    const code = `${opener}\n${'const name = "*literal*";\n\n'.repeat(200)}${closer}\n\n`
    const markdown = prefix + code + 'After the code'
    const send = vi.fn(async (_content: RichMessageContent) => undefined)

    await sendRichMarkdown(send, markdown)

    const parts = send.mock.calls.map(([content]) => content.markdown)
    expect(parts).toEqual([prefix, code + 'After the code'])
    expect(parts.join('')).toBe(markdown)
  }
)

test('keeps a Markdown table together when a preceding paragraph fills the first message', async () => {
  const prefix = 'p'.repeat(32000) + '\n\n'
  const table =
    '| Name | Value |\n| --- | --- |\n' + '| Example | $10 |\n'.repeat(100)
  const send = vi.fn(async (_content: RichMessageContent) => undefined)

  await sendRichMarkdown(send, prefix + table)

  expect(send.mock.calls.map(([content]) => content.markdown)).toEqual([
    prefix,
    table,
  ])
})

test('preserves every character of a single oversized block through literal rich paragraphs', async () => {
  const markdown = '**' + 'x'.repeat(32763) + '👩🏽‍💻'.repeat(2000) + '**'
  const send = vi.fn(async (_content: RichMessageContent) => undefined)

  await sendRichMarkdown(send, markdown)

  const parts = send.mock.calls.map(([content]) => {
    expect(content.markdown).toBeUndefined()
    const block = content.blocks?.[0]
    if (block?.type !== 'paragraph' || typeof block.text !== 'string')
      throw new TypeError('Expected a literal paragraph')
    expect(block.text.length).toBeLessThanOrEqual(32768)
    expect(block.text.isWellFormed()).toBe(true)
    return block.text
  })
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.join('')).toBe(markdown)
})

test.each(['', '  \n\n', '\t\r\n'])(
  'rejects blank rich content %j',
  async (markdown) => {
    const send = vi.fn(async (_content: RichMessageContent) => undefined)

    await expect(sendRichMarkdown(send, markdown)).rejects.toThrow(
      'Cannot send a blank rich message'
    )

    expect(send).not.toHaveBeenCalled()
  }
)

test('waits for each rich message before sending its continuation', async () => {
  let release: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const send = vi.fn(async (_content: RichMessageContent) => {
    await blocked
  })

  const sending = sendRichMarkdown(send, 'Paragraph\n\n'.repeat(6000))
  expect(send).toHaveBeenCalledTimes(1)
  release?.()
  await sending

  expect(send.mock.calls.length).toBeGreaterThan(1)
})

test('honors grammY retry_after without duplicating successful chunks', async () => {
  const rateLimit = new GrammyError(
    'Rate limited',
    {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 2 },
    },
    'sendRichMessage',
    {}
  )
  const send = vi
    .fn(async (_content: RichMessageContent) => undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(rateLimit)
  const markdown = ('p'.repeat(20000) + '\n\n').repeat(2)

  await sendRichMarkdown(send, markdown)

  expect(delay).toHaveBeenCalledExactlyOnceWith(2000)
  expect(send.mock.calls).toHaveLength(3)
  expect(send.mock.calls[1]).toEqual(send.mock.calls[2])
})

test('falls back only the rejected chunk to literal text after a rich formatting error', async () => {
  const invalid = new GrammyError(
    'Invalid formatting',
    {
      ok: false,
      error_code: 400,
      description: 'Bad Request: too many rich message blocks',
    },
    'sendRichMessage',
    {}
  )
  const paragraph = 'p'.repeat(20000) + '\n\n'
  const send = vi
    .fn(async (_content: RichMessageContent) => undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(invalid)

  await sendRichMarkdown(send, paragraph.repeat(2))

  expect(send.mock.calls.map(([content]) => content)).toEqual([
    { markdown: paragraph },
    { markdown: paragraph },
    {
      blocks: [{ type: 'paragraph', text: paragraph }],
      skip_entity_detection: true,
    },
  ])
})

test('propagates permission failures without resending or stripping formatting', async () => {
  const failure = new GrammyError(
    'Forbidden',
    { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' },
    'sendRichMessage',
    {}
  )
  const send = vi
    .fn(async (_content: RichMessageContent) => undefined)
    .mockRejectedValue(failure)

  await expect(sendRichMarkdown(send, '**Hello**')).rejects.toBe(failure)

  expect(send).toHaveBeenCalledTimes(1)
})

test('uses the existing grammY HTTP client for the native rich endpoint', async () => {
  const payloads: unknown[] = []
  const paths: string[] = []
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = []
    for await (const chunk of req) buffers.push(Buffer.from(chunk))
    payloads.push(JSON.parse(Buffer.concat(buffers).toString()))
    paths.push(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({ ok: true, result: { message_id: payloads.length } })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new TypeError('Expected HTTP server address')
  const api = new Api('123:test-token', {
    apiRoot: `http://127.0.0.1:${address.port}`,
  })
  const markdown =
    '# Comparison\n\n| Model | Price |\n| --- | --- |\n| A | $10 |\n\n```ts\nconst file_name = "**literal**";\n```'

  try {
    await sendRichMarkdown(
      (content) =>
        api.sendRichMessage(100, content, {
          message_thread_id: 7,
          reply_parameters: { message_id: 42 },
        }),
      markdown
    )

    expect(paths).toEqual(['/bot123:test-token/sendRichMessage'])
    expect(
      payloads.map((payload) =>
        z
          .object({
            chat_id: z.literal(100),
            rich_message: z.object({ markdown: z.string() }),
            message_thread_id: z.literal(7),
            reply_parameters: z.object({ message_id: z.literal(42) }),
          })
          .parse(payload)
      )
    ).toEqual([
      {
        chat_id: 100,
        rich_message: { markdown },
        message_thread_id: 7,
        reply_parameters: { message_id: 42 },
      },
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
