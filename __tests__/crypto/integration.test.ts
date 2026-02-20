// __tests__/crypto/integration.test.ts
import {
  generateSalt,
  deriveKey,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  computeVerifier,
} from '../../app/crypto/encryption.js';
import { encryptMessageFields, decryptMessageFields } from '../../app/crypto/message-crypto.js';

describe('encryption integration', () => {
  it('simulates full agent lifecycle: init → encrypt → decrypt', () => {
    // 1. milo init: user enters password
    const password = 'my-secret-password';
    const salt = generateSalt();
    const mk = deriveKey(password, salt);
    const dek = generateDEK();
    const { wrapped, iv } = wrapDEK(dek, mk);
    const verifier = computeVerifier(mk);

    // 2. Agent startup: load DEK from stored config
    const mk2 = deriveKey(password, salt);
    const loadedDEK = unwrapDEK(wrapped, iv, mk2);
    expect(loadedDEK.equals(dek)).toBe(true);
    expect(computeVerifier(mk2)).toBe(verifier);

    // 3. Encrypt outgoing message (all fields)
    const original = {
      content: 'Hello from agent!',
      formData: { formId: 'f1', fields: [{ name: 'email', value: 'test@test.com' }] },
      fileData: { filename: 'readme.md', content: '# Hello', mimeType: 'text/markdown', sizeBytes: 7 },
    };
    const encrypted = encryptMessageFields(original, loadedDEK);
    expect(encrypted.content).toMatch(/^ENC:1:/);
    expect((encrypted.formData as Record<string, string>)._enc).toMatch(/^ENC:1:/);
    expect((encrypted.fileData as Record<string, unknown>).content).toMatch(/^ENC:1:/);
    // Metadata preserved
    expect((encrypted.fileData as Record<string, unknown>).filename).toBe('readme.md');

    // 4. Decrypt incoming message (simulating browser/agent receiving)
    const decrypted = decryptMessageFields(encrypted, loadedDEK);
    expect(decrypted.content).toBe('Hello from agent!');
    expect(decrypted.formData).toEqual(original.formData);
    expect((decrypted.fileData as Record<string, unknown>).content).toBe('# Hello');
    expect((decrypted.fileData as Record<string, unknown>).filename).toBe('readme.md');
  });

  it('simulates password change without re-encrypting messages', () => {
    const oldPassword = 'old-pass';
    const newPassword = 'new-pass';
    const salt = generateSalt();

    // Setup with old password
    const oldMK = deriveKey(oldPassword, salt);
    const dek = generateDEK();
    const { wrapped: oldWrapped, iv: oldIV } = wrapDEK(dek, oldMK);

    // Encrypt a message with the DEK
    const encrypted = encryptMessageFields({ content: 'secret data' }, dek);
    expect(encrypted.content).toMatch(/^ENC:1:/);

    // Change password: unwrap with old, re-wrap with new
    const unwrapped = unwrapDEK(oldWrapped, oldIV, oldMK);
    expect(unwrapped.equals(dek)).toBe(true);

    const newSalt = generateSalt();
    const newMK = deriveKey(newPassword, newSalt);
    const { wrapped: newWrapped, iv: newIV } = wrapDEK(unwrapped, newMK);

    // Load with new password → same DEK
    const loadedDEK = unwrapDEK(newWrapped, newIV, newMK);
    expect(loadedDEK.equals(dek)).toBe(true);

    // Old encrypted message still decrypts correctly
    const decrypted = decryptMessageFields(encrypted, loadedDEK);
    expect(decrypted.content).toBe('secret data');
  });

  it('verifier detects wrong password', () => {
    const salt = generateSalt();
    const mk = deriveKey('correct-password', salt);
    const verifier = computeVerifier(mk);

    // Wrong password produces different verifier
    const wrongMK = deriveKey('wrong-password', salt);
    expect(computeVerifier(wrongMK)).not.toBe(verifier);

    // Correct password matches
    const correctMK = deriveKey('correct-password', salt);
    expect(computeVerifier(correctMK)).toBe(verifier);
  });

  it('mixed encrypted and plaintext messages coexist', () => {
    const dek = generateDEK();

    // Encrypt some messages
    const encrypted = encryptMessageFields({ content: 'encrypted msg' }, dek);

    // Plaintext message (as if from before encryption was enabled)
    const plaintext = { content: 'old plaintext msg' };

    // Decrypt handles both
    const decryptedEnc = decryptMessageFields(encrypted, dek);
    const decryptedPlain = decryptMessageFields(plaintext, dek);

    expect(decryptedEnc.content).toBe('encrypted msg');
    expect(decryptedPlain.content).toBe('old plaintext msg');
  });
});
