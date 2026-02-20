// __tests__/crypto/message-crypto.test.ts
import { encryptMessageFields, decryptMessageFields } from '../../app/crypto/message-crypto.js';
import { generateDEK } from '../../app/crypto/encryption.js';

describe('message-crypto', () => {
  let dek: Buffer;

  beforeAll(() => {
    dek = generateDEK();
  });

  describe('encryptMessageFields', () => {
    it('encrypts content field', () => {
      const result = encryptMessageFields({ content: 'hello' }, dek);
      expect(result.content).toMatch(/^ENC:1:/);
    });

    it('encrypts formData as JSON', () => {
      const formData = { formId: 'f1', fields: [{ name: 'email' }] };
      const result = encryptMessageFields({ content: 'hello', formData }, dek);
      expect(result.formData).toHaveProperty('_enc');
      expect((result.formData as Record<string, string>)._enc).toMatch(/^ENC:1:/);
    });

    it('encrypts fileData.content but preserves metadata', () => {
      const fileData = {
        filename: 'doc.pdf',
        content: 'base64filedata',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
      };
      const result = encryptMessageFields({ content: 'hello', fileData }, dek);
      const fd = result.fileData as Record<string, unknown>;
      expect(fd.filename).toBe('doc.pdf');
      expect(fd.mimeType).toBe('application/pdf');
      expect(fd.sizeBytes).toBe(1234);
      expect(fd.content).toMatch(/^ENC:1:/);
    });

    it('handles missing optional fields', () => {
      const result = encryptMessageFields({ content: 'hello' }, dek);
      expect(result.formData).toBeUndefined();
      expect(result.fileData).toBeUndefined();
    });
  });

  describe('decryptMessageFields', () => {
    it('round-trips all fields', () => {
      const original = {
        content: 'secret message',
        formData: { formId: 'f1', fields: [] },
        fileData: {
          filename: 'test.txt',
          content: 'filecontent',
          mimeType: 'text/plain',
          sizeBytes: 11,
        },
      };
      const encrypted = encryptMessageFields(original, dek);
      const decrypted = decryptMessageFields(encrypted, dek);
      expect(decrypted.content).toBe('secret message');
      expect(decrypted.formData).toEqual(original.formData);
      expect((decrypted.fileData as Record<string, unknown>).content).toBe('filecontent');
    });

    it('passes through plaintext content', () => {
      const result = decryptMessageFields({ content: 'plain' }, dek);
      expect(result.content).toBe('plain');
    });

    it('passes through null formData/fileData', () => {
      const result = decryptMessageFields({ content: 'plain' }, dek);
      expect(result.formData).toBeUndefined();
      expect(result.fileData).toBeUndefined();
    });
  });
});
