const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export class ImageInputError extends Error {
  override readonly name = 'ImageInputError'

  constructor(readonly reason: 'download' | 'size' | 'format') {
    super(`Image input failed: ${reason}`)
  }
}

export async function downloadImageDataUrl(
  url: string,
  signal: AbortSignal
): Promise<string> {
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  try {
    const response = await fetch(url, { signal: downloadSignal })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new ImageInputError('download')
    }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      await response.body.cancel()
      throw new ImageInputError('size')
    }

    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MAX_IMAGE_BYTES) throw new ImageInputError('size')
      chunks.push(chunk)
    }
    downloadSignal.throwIfAborted()
    const bytes = Buffer.concat(chunks, size)
    const mimeType = detectImageType(bytes)
    return `data:${mimeType};base64,${bytes.toString('base64')}`
  } catch (error) {
    downloadSignal.throwIfAborted()
    if (error instanceof ImageInputError) throw error
    // Fetch errors can contain Telegram's bot token in their URL or cause.
    throw new ImageInputError('download')
  }
}

function detectImageType(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg'
  }
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    return 'image/gif'
  }
  throw new ImageInputError('format')
}
