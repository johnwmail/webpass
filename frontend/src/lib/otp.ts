/**
 * TOTP utilities for pass-otp compatible time-based one-time passwords
 * 
 * Implements RFC 6238 (TOTP) using the otpauth library
 * https://tools.ietf.org/html/rfc6238
 */

import * as OTPAuth from 'otpauth';

/**
 * TOTPEntry represents a parsed TOTP URI
 */
export interface TOTPEntry {
  type: 'totp';
  issuer: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
}

/**
 * Parse an otpauth:// URI into a TOTPEntry object
 * Returns null if the URI is invalid or not a TOTP URI
 */
export function parseOTPURI(uri: string): TOTPEntry | null {
  try {
    // Must start with otpauth://
    if (!uri.startsWith('otpauth://')) {
      return null;
    }

    const url = new URL(uri);
    
    // Must be otpauth: protocol
    if (url.protocol !== 'otpauth:') {
      return null;
    }

    // The pathname format is /label (e.g., /GitHub:user or /Service:account)
    // The host part tells us if it's totp or hotp
    // Format: otpauth://totp/Label or otpauth://hotp/Label
    const host = url.host.toLowerCase();
    if (host !== 'totp') {
      return null; // Only support TOTP, not HOTP
    }

    const path = url.pathname;
    if (!path.startsWith('/')) {
      return null;
    }

    // Decode and parse the label (format: "Issuer:account" or just "account")
    const label = decodeURIComponent(path.substring(1));
    const [issuer, ...accountParts] = label.split(':');
    const account = accountParts.join(':') || issuer;

    const params = url.searchParams;
    const secret = params.get('secret');
    
    // Secret is required
    if (!secret) {
      return null;
    }

    // Validate Base32 secret (A-Z, 2-7, and = padding)
    // Note: We accept lowercase and convert to uppercase
    const upperSecret = secret.toUpperCase();
    if (!/^[A-Z2-7=]+$/.test(upperSecret)) {
      return null;
    }

    return {
      type: 'totp',
      issuer: params.get('issuer') || issuer,
      account,
      secret: upperSecret,
      algorithm: params.get('algorithm') || 'SHA1',
      digits: parseInt(params.get('digits') || '6', 10),
      period: parseInt(params.get('period') || '30', 10),
    };
  } catch {
    return null;
  }
}

/**
 * Generate current 6-digit TOTP code from a secret
 * @param secret - Base32-encoded secret
 * @param period - Time period in seconds (default: 30)
 * @returns 6-digit code as string
 */
export function generateTOTPCode(secret: string, period: number = 30): string {
  const totp = new OTPAuth.TOTP({
    issuer: '',
    label: 'WebPass',
    algorithm: 'SHA1',
    digits: 6,
    period: period,
    secret: secret,
  });
  
  return totp.generate();
}

/**
 * Extract the last valid otpauth://totp/ URI from entry content
 * Returns null if no valid TOTP URI found
 */
export function extractLastTOTPURI(content: string): string | null {
  const lines = content.split('\n');
  let lastValidURI: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('otpauth://totp/')) {
      // Validate the URI
      if (parseOTPURI(trimmed) !== null) {
        lastValidURI = trimmed;
      }
    }
  }

  return lastValidURI;
}

export interface EntryContentParts {
  password: string;
  notes: string;
  otpUri: string;
}

/**
 * Split password-store content into password, notes, and the pass-otp URI.
 *
 * The URI is removed from notes so it can be edited in a dedicated field and
 * is not displayed or saved twice.
 */
export function splitEntryContent(text: string): EntryContentParts {
  const lines = text.split('\n');
  const otpUri = extractLastTOTPURI(text) || '';
  const notesLines = lines.slice(1);

  return {
    password: lines[0] || '',
    notes: (otpUri
      ? notesLines.filter(line => line.trim() !== otpUri)
      : notesLines
    ).join('\n').trim(),
    otpUri,
  };
}

/**
 * Build password-store content from the form fields.
 *
 * Keeps the pass-otp URI as its own line, using the same format as the
 * `pass otp` extension so import/export and git sync stay compatible.
 */
export function buildEntryContent(password: string, notes: string, otpUri = ''): string {
  let content = password;
  if (notes.trim()) {
    content += '\n' + notes.trim();
  }
  if (otpUri.trim()) {
    content += '\n' + otpUri.trim();
  }
  return content + '\n';
}

/**
 * Check if content has any otpauth:// lines (valid or invalid)
 */
export function hasAnyOTPURI(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('otpauth://')) {
      return true;
    }
  }
  return false;
}

/**
 * Find all invalid otpauth:// lines in content
 * Returns array of invalid URIs (empty if all are valid or none found)
 */
export function findInvalidOTPUris(content: string): string[] {
  const lines = content.split('\n');
  const invalid: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('otpauth://')) {
      // If it starts with otpauth:// but doesn't parse, it's invalid
      if (parseOTPURI(trimmed) === null) {
        invalid.push(trimmed);
      }
    }
  }

  return invalid;
}

/**
 * Get a human-readable hint about why a TOTP URI is invalid
 */
export function getTOTPErrorHint(uri: string): string {
  if (!uri.startsWith('otpauth://')) {
    return 'Invalid URI format';
  }

  if (!uri.includes('totp')) {
    return 'Only TOTP (time-based) is supported, not HOTP';
  }

  if (!uri.includes('?')) {
    return 'Missing parameters (no ? found)';
  }

  if (!uri.includes('secret=')) {
    return "Missing 'secret' parameter";
  }

  // Try to extract and validate secret
  try {
    const url = new URL(uri);
    const secret = url.searchParams.get('secret');
    if (!secret) {
      return "Missing 'secret' parameter";
    }
    if (!/^[A-Z2-7=]+$/.test(secret.toUpperCase())) {
      return 'Invalid Base32 secret (must contain A-Z, 2-7)';
    }
  } catch {
    return 'Malformed URI';
  }

  return 'Invalid TOTP URI format';
}
