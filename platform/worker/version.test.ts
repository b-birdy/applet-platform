import { describe, it, expect } from 'vitest';
import { normalizeVersion } from './data';

describe('normalizeVersion', () => {
  it('normalizes two-level and three-level forms to v<major>.<minor>', () => {
    expect(normalizeVersion('v0.1')).toBe('v0.1');
    expect(normalizeVersion('0.1')).toBe('v0.1');
    expect(normalizeVersion('1.0.0')).toBe('v1.0');
    expect(normalizeVersion('v2.3.9')).toBe('v2.3');
    expect(normalizeVersion('2')).toBe('v2.0');
    expect(normalizeVersion('V10.20')).toBe('v10.20');
    expect(normalizeVersion(' 1.0 ')).toBe('v1.0');
  });

  it('returns null for empty or invalid input', () => {
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion('')).toBeNull();
    expect(normalizeVersion('abc')).toBeNull();
    expect(normalizeVersion('1.2.3.4')).toBeNull();
    expect(normalizeVersion('1..0')).toBeNull();
  });
});
