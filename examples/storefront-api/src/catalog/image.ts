/** Media types accepted for product images. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

/**
 * Detects the type of an image from its first bytes ("magic numbers").
 *
 * The media type of an upload (`File.type`) is whatever the client declared: the `mimeTypes` option
 * of `@UploadedFile` rejects honest mistakes, not attackers. The content decides what is stored.
 */
export function detectImageType(bytes: Uint8Array): ImageType | undefined {
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return undefined
}

/** File extension of an image type. */
export function imageExtension(type: ImageType): string {
  return type === 'image/jpeg' ? '.jpg' : `.${type.slice('image/'.length)}`
}
