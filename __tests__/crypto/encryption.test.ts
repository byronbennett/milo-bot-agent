import {
  generateSalt,
  deriveKey,
  encrypt,
  decrypt,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  computeVerifier,
  isEncrypted,
} from '../../app/crypto/encryption.js';

describe('crypto/encryption', () => {
  const password = 'test-password-123';

  describe('generateSalt', () => {
    it('returns a 32-byte buffer', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it('returns unique values', () => {
      const a = generateSalt();
      const b = generateSalt();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it('derives a 32-byte key from password and salt', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('same password + salt = same key', () => {
      const salt = generateSalt();
      const a = deriveKey(password, salt);
      const b = deriveKey(password, salt);
      expect(a.equals(b)).toBe(true);
    });

    it('different passwords = different keys', () => {
      const salt = generateSalt();
      const a = deriveKey('password-a', salt);
      const b = deriveKey('password-b', salt);
      expect(a.equals(b)).toBe(false);
    });

    it('different salts = different keys', () => {
      const a = deriveKey(password, generateSalt());
      const b = deriveKey(password, generateSalt());
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips plaintext', () => {
      const key = deriveKey(password, generateSalt());
      const plaintext = 'Hello, encrypted world!';
      const encrypted = encrypt(plaintext, key);
      expect(encrypted).toMatch(/^ENC:1:/);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('decrypt passes through non-encrypted content', () => {
      const key = deriveKey(password, generateSalt());
      expect(decrypt('plain text', key)).toBe('plain text');
    });

    it('different IVs produce different ciphertext', () => {
      const key = deriveKey(password, generateSalt());
      const a = encrypt('same text', key);
      const b = encrypt('same text', key);
      expect(a).not.toBe(b);
    });

    it('wrong key fails to decrypt', () => {
      const salt = generateSalt();
      const key1 = deriveKey('password-1', salt);
      const key2 = deriveKey('password-2', salt);
      const encrypted = encrypt('secret', key1);
      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('handles empty string', () => {
      const key = deriveKey(password, generateSalt());
      const encrypted = encrypt('', key);
      expect(decrypt(encrypted, key)).toBe('');
    });

    it('handles unicode', () => {
      const key = deriveKey(password, generateSalt());
      const text = 'Hello \u{1F600} world \u4E16\u754C';
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    });

    it('handles large content', () => {
      const key = deriveKey(password, generateSalt());
      const text = 'x'.repeat(100_000);
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    });
  });

  describe('DEK wrap / unwrap', () => {
    it('round-trips DEK', () => {
      const salt = generateSalt();
      const mk = deriveKey(password, salt);
      const dek = generateDEK();
      expect(dek.length).toBe(32);

      const { wrapped, iv } = wrapDEK(dek, mk);
      const unwrapped = unwrapDEK(wrapped, iv, mk);
      expect(unwrapped.equals(dek)).toBe(true);
    });

    it('wrong master key fails to unwrap', () => {
      const mk1 = deriveKey('pass-1', generateSalt());
      const mk2 = deriveKey('pass-2', generateSalt());
      const dek = generateDEK();
      const { wrapped, iv } = wrapDEK(dek, mk1);
      expect(() => unwrapDEK(wrapped, iv, mk2)).toThrow();
    });
  });

  describe('computeVerifier', () => {
    it('returns a base64 string', () => {
      const key = deriveKey(password, generateSalt());
      const v = computeVerifier(key);
      expect(typeof v).toBe('string');
      expect(Buffer.from(v, 'base64').length).toBe(32);
    });

    it('same key = same verifier', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      expect(computeVerifier(key)).toBe(computeVerifier(key));
    });

    it('different keys = different verifiers', () => {
      const a = computeVerifier(deriveKey('a', generateSalt()));
      const b = computeVerifier(deriveKey('b', generateSalt()));
      expect(a).not.toBe(b);
    });
  });

  describe('isEncrypted', () => {
    it('returns true for encrypted content', () => {
      const key = deriveKey(password, generateSalt());
      expect(isEncrypted(encrypt('hello', key))).toBe(true);
    });

    it('returns false for plaintext', () => {
      expect(isEncrypted('hello')).toBe(false);
    });
  });
});
