import { randomInt } from 'node:crypto';

/**
 * 31-symbol alphabet with ambiguous characters removed (no 0/O, 1/I/L).
 * 31^8 ≈ 8.5e11 combinations ≈ 40 bits of entropy per key.
 */
export const SHARE_KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHARE_KEY_LENGTH = 8;

/** Same symbol set as the alphabet: digits 2-9, letters minus I, L, O. */
const SHARE_KEY_PATTERN = /^[2-9A-HJKMNP-Z]{8}$/;

/** Reject absurd inputs before touching the regex (keys travel in URLs). */
const MAX_RAW_KEY_LENGTH = 32;

export function generateShareKey(): string {
  let key = '';
  for (let i = 0; i < SHARE_KEY_LENGTH; i += 1) {
    key += SHARE_KEY_ALPHABET.charAt(randomInt(SHARE_KEY_ALPHABET.length));
  }
  return key;
}

/**
 * Canonicalize user input: trim, uppercase, drop spaces/dashes, then validate
 * strictly against the alphabet. Returns null for anything unusable so the
 * caller can answer with the generic not-found response.
 */
export function normalizeShareKey(raw: string): string | null {
  if (raw.length > MAX_RAW_KEY_LENGTH) return null;
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
  return SHARE_KEY_PATTERN.test(compact) ? compact : null;
}

/** Display form: 7K4P9XQM → 7K4P-9XQM. */
export function formatShareKey(canonical: string): string {
  return `${canonical.slice(0, 4)}-${canonical.slice(4)}`;
}
