// app/crypto/message-crypto.ts
import { encrypt, decrypt, isEncrypted } from './encryption.js';

export interface MessageFields {
  content: string;
  formData?: Record<string, unknown> | null;
  fileData?: Record<string, unknown> | null;
}

export function encryptMessageFields(fields: MessageFields, dek: Buffer): MessageFields {
  const result: MessageFields = {
    content: encrypt(fields.content, dek),
  };

  if (fields.formData) {
    result.formData = { _enc: encrypt(JSON.stringify(fields.formData), dek) };
  }

  if (fields.fileData) {
    const fd = { ...fields.fileData };
    if (typeof fd.content === 'string') {
      fd.content = encrypt(fd.content, dek);
    }
    result.fileData = fd;
  }

  return result;
}

export function decryptMessageFields(fields: MessageFields, dek: Buffer): MessageFields {
  const result: MessageFields = {
    content: decrypt(fields.content, dek),
  };

  if (fields.formData) {
    const fd = fields.formData as Record<string, unknown>;
    if (fd._enc && typeof fd._enc === 'string' && isEncrypted(fd._enc)) {
      result.formData = JSON.parse(decrypt(fd._enc as string, dek));
    } else {
      result.formData = fields.formData;
    }
  }

  if (fields.fileData) {
    const fd = { ...fields.fileData };
    if (typeof fd.content === 'string' && isEncrypted(fd.content)) {
      fd.content = decrypt(fd.content, dek);
    }
    result.fileData = fd;
  }

  return result;
}
