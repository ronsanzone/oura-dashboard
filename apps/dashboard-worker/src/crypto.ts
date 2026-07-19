import { timingSafeEqual } from "node:crypto"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const encryptionKey = async (encoded: string): Promise<CryptoKey> => {
  const bytes = base64ToBytes(encoded)
  if (bytes.byteLength !== 32) throw new Error("OURA_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
  return crypto.subtle.importKey("raw", asArrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"])
}

export const encrypt = async (plaintext: string, encodedKey: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(encodedKey), encoder.encode(plaintext))
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`
}

export const decrypt = async (value: string, encodedKey: string): Promise<string> => {
  const [iv, ciphertext] = value.split(".")
  if (!iv || !ciphertext) throw new Error("Invalid encrypted token")
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(base64ToBytes(iv)) },
    await encryptionKey(encodedKey),
    asArrayBuffer(base64ToBytes(ciphertext))
  )
  return decoder.decode(plaintext)
}

export const randomState = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))

export const sha256 = async (value: string): Promise<string> =>
  bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))

export const constantTimeEqual = async (left: string, right: string): Promise<boolean> => {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ])
  return timingSafeEqual(new Uint8Array(leftDigest), new Uint8Array(rightDigest))
}
