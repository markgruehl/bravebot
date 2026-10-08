import { describe, expect, it } from 'vitest';
import { nameKey, validateSoundName } from './names.js';

describe('validateSoundName', () => {
  it('accepts and trims a normal name', () => {
    expect(validateSoundName('  Airhorn  ')).toEqual({ ok: true, name: 'Airhorn' });
  });

  it('collapses internal whitespace and preserves case', () => {
    expect(validateSoundName('Big   Sad\tTrombone')).toEqual({ ok: true, name: 'Big Sad Trombone' });
  });

  it('rejects empty / whitespace-only names', () => {
    expect(validateSoundName('').ok).toBe(false);
    expect(validateSoundName('    ').ok).toBe(false);
  });

  it('enforces 1-32 characters counted in code points', () => {
    expect(validateSoundName('a')).toEqual({ ok: true, name: 'a' });
    expect(validateSoundName('x'.repeat(32)).ok).toBe(true);
    const tooLong = validateSoundName('x'.repeat(33));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toMatch(/32/);
    // 32 emoji = 64 UTF-16 units but 32 code points
    expect(validateSoundName('🎺'.repeat(32)).ok).toBe(true);
    expect(validateSoundName('🎺'.repeat(33)).ok).toBe(false);
  });

  it('rejects newlines and control characters', () => {
    expect(validateSoundName('two\nlines').ok).toBe(false);
    expect(validateSoundName('cr\rhere').ok).toBe(false);
    expect(validateSoundName('bell\u0007').ok).toBe(false);
    expect(validateSoundName('nul\u0000x').ok).toBe(false);
  });

  it('allows punctuation and unicode', () => {
    expect(validateSoundName("Bruh's #1 sound!").ok).toBe(true);
    expect(validateSoundName('Café 🎉').ok).toBe(true);
  });
});

describe('nameKey', () => {
  it('is case-insensitive and whitespace-normalized', () => {
    expect(nameKey('AirHorn')).toBe(nameKey('airhorn'));
    expect(nameKey('  Big  Sad ')).toBe(nameKey('big sad'));
  });

  it('treats unicode-equivalent forms as equal', () => {
    expect(nameKey('Café')).toBe(nameKey('Café'));
    expect(nameKey('ＡＢＣ')).toBe(nameKey('abc'));
  });

  it('distinguishes different names', () => {
    expect(nameKey('horn')).not.toBe(nameKey('horns'));
  });
});
