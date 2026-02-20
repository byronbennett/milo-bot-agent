import {
  randomBytes,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'crypto';

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENC_PREFIX = 'ENC:1:';

export function generateSalt(): Buffer {
  return randomBytes(32);
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

export function generateDEK(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ct, tag]);
  return ENC_PREFIX + blob.toString('base64');
}

export function decrypt(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(ENC_PREFIX)) return encrypted;
  const blob = Buffer.from(encrypted.slice(ENC_PREFIX.length), 'base64');
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ct = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}

export function wrapDEK(dek: Buffer, masterKey: Buffer): { wrapped: string; iv: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    wrapped: Buffer.concat([ct, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function unwrapDEK(wrapped: string, iv: string, masterKey: Buffer): Buffer {
  const blob = Buffer.from(wrapped, 'base64');
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ct = blob.subarray(0, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function computeVerifier(masterKey: Buffer): string {
  return createHmac('sha256', masterKey).update('milo-verify').digest('base64');
}

export function isEncrypted(content: string): boolean {
  return content.startsWith(ENC_PREFIX);
}
