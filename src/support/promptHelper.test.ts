import { describe, it, expect } from 'vitest';
import { resolveChoice, resolveConfirm, type ChoiceOption } from './promptHelper.js';

const opts: ChoiceOption<string>[] = [
  { label: 'local', value: 'L' },
  { label: 'linear', value: 'N' },
];

describe('resolveChoice', () => {
  it('matches a 1-based index', () => {
    expect(resolveChoice('1', opts)?.value).toBe('L');
    expect(resolveChoice('2', opts)?.value).toBe('N');
  });
  it('matches an exact label case-insensitively', () => {
    expect(resolveChoice('LINEAR', opts)?.value).toBe('N');
    expect(resolveChoice(' local ', opts)?.value).toBe('L');
  });
  it('returns null for out-of-range index, unknown label, or blank', () => {
    expect(resolveChoice('0', opts)).toBeNull();
    expect(resolveChoice('3', opts)).toBeNull();
    expect(resolveChoice('nope', opts)).toBeNull();
    expect(resolveChoice('', opts)).toBeNull();
  });
});

describe('resolveConfirm', () => {
  it('takes the default on blank', () => {
    expect(resolveConfirm('', true)).toBe(true);
    expect(resolveConfirm('  ', false)).toBe(false);
  });
  it('parses yes/no variants', () => {
    for (const y of ['y', 'Y', 'yes', 'true']) expect(resolveConfirm(y, false)).toBe(true);
    for (const n of ['n', 'N', 'no', 'false']) expect(resolveConfirm(n, true)).toBe(false);
  });
  it('falls back to default on unrecognized input', () => {
    expect(resolveConfirm('maybe', true)).toBe(true);
    expect(resolveConfirm('maybe', false)).toBe(false);
  });
});
