/**
 * Unit tests for TOTP utilities
 */

import { describe, it, expect } from 'vitest';
import {
  parseOTPURI,
  generateTOTPCode,
  extractLastTOTPURI,
  hasAnyOTPURI,
  findInvalidOTPUris,
  getTOTPErrorHint,
} from './otp';

describe('parseOTPURI', () => {
  it('parses valid TOTP URI with all parameters', () => {
    const uri = 'otpauth://totp/GitHub:user@example.com?secret=JBSWY3DP&issuer=GitHub&algorithm=SHA1&digits=6&period=30';
    const result = parseOTPURI(uri);
    
    expect(result).not.toBeNull();
    expect(result?.type).toBe('totp');
    expect(result?.issuer).toBe('GitHub');
    expect(result?.account).toBe('user@example.com');
    expect(result?.secret).toBe('JBSWY3DP');
    expect(result?.digits).toBe(6);
    expect(result?.period).toBe(30);
  });

  it('parses valid TOTP URI with minimal parameters (secret only)', () => {
    const uri = 'otpauth://totp/Service:user?secret=JBSWY3DP';
    const result = parseOTPURI(uri);
    
    expect(result).not.toBeNull();
    expect(result?.type).toBe('totp');
    expect(result?.secret).toBe('JBSWY3DP');
    expect(result?.digits).toBe(6); // default
    expect(result?.period).toBe(30); // default
  });

  it('returns null for invalid URI (not otpauth://)', () => {
    expect(parseOTPURI('https://example.com')).toBeNull();
    expect(parseOTPURI('totp://service')).toBeNull();
  });

  it('returns null for missing secret parameter', () => {
    const uri = 'otpauth://totp/Service:user?issuer=Test';
    expect(parseOTPURI(uri)).toBeNull();
  });

  it('returns null for wrong type (otpauth://hotp/)', () => {
    const uri = 'otpauth://hotp/Service:user?secret=JBSWY3DP';
    expect(parseOTPURI(uri)).toBeNull();
  });

  it('returns null for malformed URI (no ?)', () => {
    const uri = 'otpauth://totp/Service:user';
    expect(parseOTPURI(uri)).toBeNull();
  });

  it('returns null for invalid Base32 secret', () => {
    const uri = 'otpauth://totp/Service:user?secret=12345!'; // Invalid chars
    expect(parseOTPURI(uri)).toBeNull();
  });

  it('handles lowercase secret (converts to uppercase)', () => {
    const uri = 'otpauth://totp/Service:user?secret=jbswy3dp';
    const result = parseOTPURI(uri);
    
    expect(result).not.toBeNull();
    expect(result?.secret).toBe('JBSWY3DP');
  });
});

describe('generateTOTPCode', () => {
  it('returns 6-digit code', () => {
    const code = generateTOTPCode('JBSWY3DP');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('returns same code within same period', () => {
    const code1 = generateTOTPCode('JBSWY3DP');
    const code2 = generateTOTPCode('JBSWY3DP');
    expect(code1).toBe(code2);
  });

  it('handles custom periods (60s, 3600s, 86400s)', () => {
    expect(generateTOTPCode('JBSWY3DP', 30)).toMatch(/^\d{6}$/);
    expect(generateTOTPCode('JBSWY3DP', 60)).toMatch(/^\d{6}$/);
    expect(generateTOTPCode('JBSWY3DP', 3600)).toMatch(/^\d{6}$/);
    expect(generateTOTPCode('JBSWY3DP', 86400)).toMatch(/^\d{6}$/);
  });
});

describe('extractLastTOTPURI', () => {
  it('extracts single TOTP URI at end', () => {
    const content = 'password123\nnotes\notpauth://totp/GitHub:user?secret=JBSWY3DP';
    const result = extractLastTOTPURI(content);
    
    expect(result).toBe('otpauth://totp/GitHub:user?secret=JBSWY3DP');
  });

  it('extracts last valid URI from multiple TOTP URIs', () => {
    const content = `password
otpauth://totp/OldService:user?secret=GEZDGNBV
some notes
otpauth://totp/GitHub:user?secret=JBSWY3DP`;
    
    const result = extractLastTOTPURI(content);
    expect(result).toBe('otpauth://totp/GitHub:user?secret=JBSWY3DP');
  });

  it('returns null when no TOTP URI', () => {
    const content = 'password\nnotes';
    expect(extractLastTOTPURI(content)).toBeNull();
  });

  it('trims whitespace from TOTP URI', () => {
    const content = 'password\n  otpauth://totp/Service:user?secret=JBSWY3DP  ';
    const result = extractLastTOTPURI(content);
    
    expect(result).toBe('otpauth://totp/Service:user?secret=JBSWY3DP');
  });

  it('handles mixed content (password, notes, TOTP)', () => {
    const content = `mySecretPassword
username: john@example.com
recovery: 555-1234
otpauth://totp/GitHub:john@example.com?secret=JBSWY3DP&issuer=GitHub`;
    
    const result = extractLastTOTPURI(content);
    expect(result).toContain('otpauth://totp/');
    expect(result).toContain('secret=JBSWY3DP');
  });

  it('ignores invalid format (missing secret)', () => {
    const content = `password
otpauth://totp/Service:user?issuer=Test`;
    
    expect(extractLastTOTPURI(content)).toBeNull();
  });

  it('ignores invalid format (bad URI)', () => {
    const content = `password
otpauth://totp/bad-uri`;
    
    expect(extractLastTOTPURI(content)).toBeNull();
  });

  it('last valid URI wins when mixed valid/invalid', () => {
    const content = `password
otpauth://totp/Valid:user?secret=JBSWY3DP
otpauth://totp/Invalid:user
otpauth://totp/AnotherValid:user?secret=GEZDGNBV`;
    
    const result = extractLastTOTPURI(content);
    expect(result).toBe('otpauth://totp/AnotherValid:user?secret=GEZDGNBV');
  });

  it('ignores otpauth:// as substring in notes', () => {
    const content = `password
This is a note about otpauth:// protocol
Another note`;
    
    expect(extractLastTOTPURI(content)).toBeNull();
  });
});

describe('hasAnyOTPURI', () => {
  it('returns true for content with valid TOTP URI', () => {
    const content = 'password\notpauth://totp/Service:user?secret=ABC123';
    expect(hasAnyOTPURI(content)).toBe(true);
  });

  it('returns true for content with invalid otpauth:// line', () => {
    const content = 'password\notpauth://totp/bad-uri';
    expect(hasAnyOTPURI(content)).toBe(true);
  });

  it('returns false for content without any otpauth://', () => {
    const content = 'password\nnotes';
    expect(hasAnyOTPURI(content)).toBe(false);
  });
});

describe('findInvalidOTPUris', () => {
  it('returns empty array for valid URI only', () => {
    const content = 'password\notpauth://totp/Service:user?secret=JBSWY3DP';
    expect(findInvalidOTPUris(content)).toEqual([]);
  });

  it('returns invalid URI (missing secret)', () => {
    const content = 'password\notpauth://totp/Service:user?issuer=Test';
    const result = findInvalidOTPUris(content);
    
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('otpauth://totp/');
  });

  it('returns only invalid URIs from mixed content', () => {
    const content = `password
otpauth://totp/Valid:user?secret=JBSWY3DP
otpauth://totp/Invalid:user`;
    
    const result = findInvalidOTPUris(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('otpauth://totp/Invalid:user');
  });

  it('returns all invalid URIs', () => {
    const content = `password
otpauth://totp/Bad1:user
otpauth://totp/Bad2:user`;
    
    const result = findInvalidOTPUris(content);
    expect(result).toHaveLength(2);
  });
});

describe('getTOTPErrorHint', () => {
  it('returns hint for missing secret', () => {
    const uri = 'otpauth://totp/Service:user?issuer=Test';
    expect(getTOTPErrorHint(uri)).toContain('secret');
  });

  it('returns hint for missing parameters', () => {
    const uri = 'otpauth://totp/Service:user';
    expect(getTOTPErrorHint(uri)).toContain('parameters');
  });

  it('returns hint for invalid Base32 secret', () => {
    const uri = 'otpauth://totp/Service:user?secret=123!';
    expect(getTOTPErrorHint(uri)).toContain('Base32');
  });

  it('returns hint for HOTP (not supported)', () => {
    const uri = 'otpauth://hotp/Service:user?secret=ABC123';
    expect(getTOTPErrorHint(uri)).toContain('HOTP');
  });
});
