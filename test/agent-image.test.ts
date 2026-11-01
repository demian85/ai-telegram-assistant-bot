import { afterEach, expect, test, vi } from 'vitest'
import {
  downloadImageDataUrl,
  ImageInputError,
} from '../src/lib/agent/image.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const telegramUrl = 'https://api.telegram.org/file/bot-secret/photos/file.jpg'

test.each([
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
  ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['webp', Buffer.from('RIFF0000WEBP')],
  ['gif', Buffer.from('GIF89a')],
] as const)(
  'detects %s from bytes rather than the file extension or HTTP type',
  async (format, bytes) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytes, {
            headers: { 'content-type': 'application/octet-stream' },
          })
      )
    )
    await expect(
      downloadImageDataUrl(telegramUrl, new AbortController().signal)
    ).resolves.toBe(`data:image/${format};base64,${bytes.toString('base64')}`)
  }
)

test.each(['', '<html>Unauthorized</html>'])(
  'rejects non-image bytes even with an image header',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-type': 'image/jpeg' },
          })
      )
    )
    await expect(
      downloadImageDataUrl(telegramUrl, new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'ImageInputError',
      reason: 'format',
    })
  }
)

test('rejects unsuccessful downloads without forwarding their response body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('bot-secret', { status: 403 }))
  )
  await expect(
    downloadImageDataUrl(telegramUrl, new AbortController().signal)
  ).rejects.toEqual(new ImageInputError('download'))
})

test('removes token-bearing URLs and causes from network errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError(`fetch failed: ${telegramUrl}`, {
        cause: new Error(telegramUrl),
      })
    })
  )
  await expect(
    downloadImageDataUrl(telegramUrl, new AbortController().signal)
  ).rejects.toEqual(new ImageInputError('download'))
})

test('rejects an oversized declared image before consuming its body', async () => {
  const cancel = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-length': String(21 * 1024 * 1024) },
        })
    )
  )
  await expect(
    downloadImageDataUrl(telegramUrl, new AbortController().signal)
  ).rejects.toMatchObject({ reason: 'size' })
  expect(cancel).toHaveBeenCalledOnce()
})

test('stops a streamed download that exceeds the limit without a length header', async () => {
  const cancel = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(11 * 1024 * 1024))
              controller.enqueue(new Uint8Array(11 * 1024 * 1024))
            },
            cancel,
          })
        )
    )
  )
  await expect(
    downloadImageDataUrl(telegramUrl, new AbortController().signal)
  ).rejects.toMatchObject({ reason: 'size' })
  expect(cancel).toHaveBeenCalledOnce()
})

test('propagates the invocation deadline to an in-progress photo download', async () => {
  const controller = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          )
        })
    )
  )
  const result = downloadImageDataUrl(telegramUrl, controller.signal)
  const assertion = expect(result).rejects.toMatchObject({
    name: 'TimeoutError',
  })
  controller.abort(new DOMException('Invocation expired', 'TimeoutError'))
  await assertion
})
