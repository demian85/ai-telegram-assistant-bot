import { afterEach, expect, test, vi } from 'vitest'
import { TelegramError } from 'telegraf'
import { sendTelegramMessage } from '../src/lib/telegram/send-message.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Telegram } from 'telegraf'
import { z } from 'zod'

afterEach(() => vi.useRealTimers())

test.each([4095, 4096, 4097, 16000])(
  'preserves all text at length %i',
  async (length) => {
    const text = 'x'.repeat(length)
    const received: string[] = []
    const send = async (part: string) => {
      expect(part.length).toBeLessThanOrEqual(4096)
      expect(part).not.toBe('')
      received.push(part)
      return received.length
    }

    const result = await sendTelegramMessage(send, text)

    expect(received.join('')).toBe(text)
    expect(result).toBe(received.length)
  }
)

test.each([
  ['paragraph', 'a'.repeat(3000) + '\n\n' + 'b'.repeat(2000), 3002],
  ['sentence', 'a'.repeat(3000) + '. ' + 'b'.repeat(2000), 3002],
  ['word', 'a'.repeat(3000) + ' ' + 'b'.repeat(2000), 3001],
] as const)('prefers a %s boundary', async (_kind, text, boundary) => {
  const send = vi.fn(async (_text: string) => undefined)

  await sendTelegramMessage(send, text)

  expect(send.mock.calls.map(([part]) => part)).toEqual([
    text.slice(0, boundary),
    text.slice(boundary),
  ])
})

test('keeps emoji and combining characters intact at a hard boundary', async () => {
  const text = 'a'.repeat(4095) + '👩🏽‍💻e\u0301'.repeat(1000)
  const received: string[] = []

  await sendTelegramMessage(async (part) => {
    received.push(part)
  }, text)

  const boundaries = new Set(
    Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      ({ index }) => index
    )
  )
  let offset = 0
  for (const part of received) {
    expect(boundaries.has(offset)).toBe(true)
    expect(part.length).toBeLessThanOrEqual(4096)
    expect(part.isWellFormed()).toBe(true)
    offset += part.length
  }
  expect(received.join('')).toBe(text)
})

test.each([
  ['Markdown', '*' + 'bold '.repeat(1500) + '*', 'bold '.repeat(1500), 'bold'],
  [
    'Markdown',
    '```ts\n' + 'const x = 1;\n'.repeat(800) + '```',
    'const x = 1;\n'.repeat(800),
    'pre',
  ],
  [
    'HTML',
    '<b>' + 'A &amp; B '.repeat(1000) + '</b>',
    'A & B '.repeat(1000),
    'bold',
  ],
  [
    'HTML',
    '<a href="https://example.com/?a=1&amp;b=2">' +
      'link '.repeat(1500) +
      '</a>',
    'link '.repeat(1500),
    'text_link',
  ],
] as const)(
  'splits %s %s with valid entities',
  async (parse_mode, input, visible, type) => {
    const received: Array<{ text: string; extra?: Record<string, unknown> }> =
      []

    await sendTelegramMessage(
      async (text, extra) => {
        received.push({ text, extra })
      },
      input,
      { parse_mode, message_thread_id: 7 }
    )

    expect(received.length).toBeGreaterThan(1)
    expect(received.map(({ text }) => text).join('')).toBe(visible)
    for (const { text, extra } of received) {
      expect(text.length).toBeLessThanOrEqual(4096)
      expect(extra).not.toHaveProperty('parse_mode')
      expect(extra?.message_thread_id).toBe(7)
      expect(extra?.entities).toEqual([
        expect.objectContaining({ type, offset: 0, length: text.length }),
      ])
      if (type === 'text_link')
        expect(extra?.entities).toEqual([
          expect.objectContaining({ url: 'https://example.com/?a=1&b=2' }),
        ])
    }
  }
)

test('does not split short rendered text because of HTML escaping overhead', async () => {
  const send = vi.fn(
    async (_text: string, _extra?: Record<string, unknown>) => undefined
  )

  await sendTelegramMessage(send, '<b>' + '&amp;'.repeat(3000) + '</b>', {
    parse_mode: 'HTML',
  })

  expect(send).toHaveBeenCalledExactlyOnceWith('&'.repeat(3000), {
    entities: [{ type: 'bold', offset: 0, length: 3000, language: undefined }],
  })
})

test('slices caller-supplied entities without changing their payloads', async () => {
  const text = 'x'.repeat(9000)
  const entities = [
    { type: 'bold', offset: 0, length: 9000 },
    { type: 'text_link', offset: 4090, length: 30, url: 'https://example.com' },
    {
      type: 'text_mention',
      offset: 8200,
      length: 5,
      user: { id: 42, is_bot: false, first_name: 'Alice' },
    },
  ] as const
  const send = vi.fn(
    async (_text: string, _extra?: Record<string, unknown>) => undefined
  )

  await sendTelegramMessage(send, text, {
    entities: [...entities],
    message_thread_id: 7,
  })

  expect(send.mock.calls.map(([part]) => part).join('')).toBe(text)
  expect(send.mock.calls.map(([, options]) => options?.entities)).toEqual([
    [
      { type: 'bold', offset: 0, length: 4096 },
      { ...entities[1], length: 6 },
    ],
    [
      { type: 'bold', offset: 0, length: 4096 },
      { ...entities[1], offset: 0, length: 24 },
    ],
    [
      { type: 'bold', offset: 0, length: 808 },
      { ...entities[2], offset: 8 },
    ],
  ])
  expect(entities[1].offset).toBe(4090)
})

test('rejects oversized raw MarkdownV2 without sending literal markup', async () => {
  const send = vi.fn(async (_text: string) => undefined)
  await expect(
    sendTelegramMessage(send, '*' + 'text '.repeat(1000) + '*', {
      parse_mode: 'MarkdownV2',
    })
  ).rejects.toBeInstanceOf(RangeError)
  expect(send).not.toHaveBeenCalled()
})

test('delivers all text when long model output has invalid Markdown', async () => {
  const input = '*Unclosed bold ' + 'full explanation '.repeat(600)
  const received: string[] = []

  await sendTelegramMessage(
    async (part, extra) => {
      expect(extra).not.toHaveProperty('parse_mode')
      expect(extra?.entities).toEqual([])
      received.push(part)
    },
    input,
    { parse_mode: 'Markdown' }
  )

  expect(received.join('')).toBe(input)
  expect(received.every((part) => part.length <= 4096)).toBe(true)
})

test('awaits each part before sending the next', async () => {
  let release: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const send = vi.fn(async (_text: string) => {
    await blocked
  })

  const sending = sendTelegramMessage(send, 'x'.repeat(9000))
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  release?.()
  await sending

  expect(send).toHaveBeenCalledTimes(3)
})

test('retries only the rate-limited part after retry_after', async () => {
  vi.useFakeTimers()
  const rateLimit = new TelegramError({
    error_code: 429,
    description: 'Too Many Requests',
    parameters: { retry_after: 2 },
  })
  const send = vi
    .fn(async (text: string) => text)
    .mockResolvedValueOnce('first')
    .mockRejectedValueOnce(rateLimit)
    .mockResolvedValueOnce('last')

  const sending = sendTelegramMessage(send, 'x'.repeat(5000))
  await vi.advanceTimersByTimeAsync(1999)
  expect(send).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await expect(sending).resolves.toBe('last')

  expect(send.mock.calls.map(([text]) => text.length)).toEqual([4096, 904, 904])
})

test('stops on a permanent send failure without resending delivered parts', async () => {
  const failure = new TelegramError({
    error_code: 403,
    description: 'Forbidden',
  })
  const send = vi
    .fn(async (_text: string) => undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(failure)

  await expect(sendTelegramMessage(send, 'x'.repeat(10000))).rejects.toBe(
    failure
  )

  expect(send).toHaveBeenCalledTimes(2)
})

test.each(['HTML', 'entities'] as const)(
  'sends bounded %s payloads through the real Telegraf HTTP client',
  async (mode) => {
    const payloads: unknown[] = []
    const server = createServer(async (req, res) => {
      const buffers: Buffer[] = []
      for await (const chunk of req) buffers.push(Buffer.from(chunk))
      const payload: unknown = JSON.parse(Buffer.concat(buffers).toString())
      payloads.push(payload)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({ ok: true, result: { message_id: payloads.length } })
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('No HTTP test address')
    const telegram = new Telegram('123:test-token', {
      apiRoot: `http://127.0.0.1:${address.port}`,
    })
    const text = 'Complete explanation. '.repeat(1000)

    try {
      await sendTelegramMessage(
        (part, extra) => telegram.sendMessage(100, part, extra),
        mode === 'HTML' ? `<b>${text}</b>` : text,
        mode === 'entities'
          ? {
              entities: [{ type: 'bold', offset: 0, length: text.length }],
              message_thread_id: 7,
            }
          : { parse_mode: mode, message_thread_id: 7 }
      )

      const schema = z.object({
        text: z.string().min(1).max(4096),
        chat_id: z.literal(100),
        message_thread_id: z.literal(7),
        entities: z.array(
          z.object({
            type: z.literal('bold'),
            offset: z.literal(0),
            length: z.number(),
          })
        ),
      })
      const sent = payloads.map((payload) => schema.parse(payload))
      expect(sent.length).toBeGreaterThan(1)
      expect(sent.map(({ text }) => text).join('')).toBe(text)
      expect(
        sent.every(({ text, entities }) => entities[0]?.length === text.length)
      ).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
)
