import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_KEY_ALPHABET,
  SHARE_KEY_LENGTH,
  formatShareKey,
  generateShareKey,
  normalizeShareKey,
} from '../src/lib/keys.js';

describe('share keys', () => {
  it('uses a 31-symbol unambiguous alphabet at length 8', () => {
    assert.equal(SHARE_KEY_ALPHABET.length, 31);
    assert.equal(SHARE_KEY_LENGTH, 8);
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      assert.ok(!SHARE_KEY_ALPHABET.includes(ambiguous), `${ambiguous} excluded`);
    }
  });

  it('generates canonical keys in format and charset', () => {
    for (let i = 0; i < 50; i += 1) {
      const key = generateShareKey();
      assert.equal(key.length, 8);
      assert.match(key, /^[2-9A-HJKMNP-Z]{8}$/);
    }
  });

  it('generates distinct keys across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateShareKey());
    assert.ok(seen.size >= 999, `expected ~1000 unique, got ${seen.size}`);
  });

  it('normalizes case, dashes, and surrounding whitespace', () => {
    assert.equal(normalizeShareKey('7k4p-9xqm'), '7K4P9XQM');
    assert.equal(normalizeShareKey('  7K4P 9XQM  '), '7K4P9XQM');
    assert.equal(normalizeShareKey('7K4P9XQM'), '7K4P9XQM');
  });

  it('rejects ambiguous, short, hostile, and overlong input', () => {
    for (const bad of [
      'IIIIIIII',
      'LLLLLLLL',
      'OOOOOOOO',
      '00000000',
      '11111111',
      'SHORT',
      '7K4P9XQ', // 7 chars
      '7K4P9XQMM', // 9 chars
      '../../etc/passwd',
      '%2e%2e%2fsecret',
      '',
      'x'.repeat(100),
    ]) {
      assert.equal(normalizeShareKey(bad), null, `rejected: ${bad.slice(0, 20)}`);
    }
  });

  it('formats the display form XXXX-XXXX', () => {
    assert.equal(formatShareKey('7K4P9XQM'), '7K4P-9XQM');
  });
});
