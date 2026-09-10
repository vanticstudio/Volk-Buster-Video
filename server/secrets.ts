/**
 * Encryption at rest for viewers' Plex tokens.
 *
 * The front door has to keep each viewer's Plex token: an instance is seeded
 * with it so the store shows THAT person's libraries and writes THEIR watch
 * state. That means this deployment holds live credentials for everyone the
 * owner shared a library with — a database file that, in plaintext, would hand
 * a reader full access to several people's Plex accounts at once.
 *
 * A stolen `store.db` is the threat being priced here: a backup copied to the
 * wrong place, a volume mounted somewhere unexpected, a disk leaving the
 * building. Encrypting the token column means that file alone is not enough —
 * an attacker needs the key from the environment too.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails loudly at decrypt
 * rather than yielding a corrupted token that would look like an auth failure
 * and send someone debugging Plex instead of their database.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST: a live process. Anything that can read
 * the running server's memory or environment can decrypt these. That is the
 * accepted boundary — the goal is that the database at rest is not itself a
 * credential store.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const IV_BYTES = 12;   // GCM standard; 96-bit nonce
const TAG_BYTES = 16;

/**
 * Derive a 32-byte key from whatever the operator put in the environment.
 *
 * SHA-256 of the passphrase rather than a KDF like scrypt, deliberately: this
 * is not a user-chosen password being defended against offline guessing. It is
 * a machine-generated secret from the deployment's environment, and the threat
 * model above assumes an attacker who has the file but not the environment.
 * Hashing here exists to accept a key of any length, not to add work factor.
 *
 * Refuses a short key rather than stretching one. A two-character
 * TOKEN_ENCRYPTION_KEY that silently "worked" would give the appearance of
 * encryption with none of the value, and the operator would never find out.
 */
export function deriveKey(passphrase: string): Buffer {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be at least 16 characters. '
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return createHash('sha256').update(passphrase).digest();
}

/**
 * Encrypt a token for storage. Output is `iv.tag.ciphertext`, all base64url.
 *
 * A fresh random IV per call is not optional with GCM: reusing one across two
 * encryptions under the same key breaks the cipher outright and can expose the
 * plaintexts. It is stored alongside the ciphertext because it is not secret —
 * only its uniqueness matters.
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${body.toString('base64url')}`;
}

/**
 * Decrypt a stored token, or return null.
 *
 * Never throws. A row that fails to decrypt — wrong key after a rotation, a
 * tampered file, a truncated write — means that session is no longer usable,
 * which is a sign-in prompt, not a crash. Callers treat null as "this session
 * is over" and the viewer simply authenticates again.
 */
export function decryptToken(stored: string, key: Buffer): string | null {
  try {
    if (typeof stored !== 'string') return null;
    const parts = stored.split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const body = Buffer.from(parts[2], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    // final() is what verifies the tag — this throws on any tampering, which is
    // the whole reason for using an authenticated mode.
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
