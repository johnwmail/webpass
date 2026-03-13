/**
 * Tar.gz extraction utility using fflate
 * 
 * Extracts .gpg files from a tar.gz archive
 */

import { gunzip } from 'fflate';

export interface TarEntry {
  path: string;
  content: Uint8Array;
}

/**
 * Extract all .gpg files from a tar.gz archive
 * 
 * @param file - The tar.gz file to extract
 * @returns Array of entries with path and content
 */
export async function extractTarGz(file: File): Promise<TarEntry[]> {
  console.log('[tar.ts] Extracting tar.gz:', file.name, 'size:', file.size, 'type:', file.type);
  
  // Read file as ArrayBuffer
  const arrayBuffer = await file.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  console.log('[tar.ts] Read', data.length, 'bytes');

  // Decompress gzip to get tar data
  console.log('[tar.ts] Decompressing gzip...');
  const tarData = await decompressGzip(data);
  console.log('[tar.ts] Decompressed to', tarData.length, 'bytes');

  // Parse tar archive
  console.log('[tar.ts] Parsing tar archive...');
  const entries = parseTar(tarData);
  console.log('[tar.ts] Found', entries.length, '.gpg entries');
  
  return entries;
}

/**
 * Decompress gzip data using fflate's gunzip
 */
async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gunzip(data, (err, result) => {
      if (err) {
        reject(new Error(`Gzip decompression failed: ${err.message}`));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Parse tar archive and extract .gpg files
 * 
 * Tar file format:
 * - 512-byte header per file
 * - Followed by file content (rounded up to 512-byte blocks)
 * - Ends with two 512-byte blocks of zeros
 */
function parseTar(data: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset < data.length) {
    // Check for end of archive (two zero blocks)
    if (isZeroBlock(data, offset)) {
      break;
    }

    // Parse tar header (512 bytes)
    const header = parseTarHeader(data, offset);
    
    if (!header || header.size === 0) {
      // Invalid header or empty entry, skip to next block
      offset += 512;
      continue;
    }

    // Move past header
    offset += 512;

    // Read file content
    const content = data.slice(offset, offset + header.size);

    // Only include .gpg files
    if (header.name.endsWith('.gpg')) {
      // Clean up path: remove leading ./ and .password-store/ prefix
      const cleanPath = cleanTarPath(header.name);
      
      if (cleanPath) {
        entries.push({
          path: cleanPath,
          content: content,
        });
      }
    }

    // Move past content (rounded up to 512-byte blocks)
    const blocks = Math.ceil(header.size / 512);
    offset += blocks * 512;
  }

  return entries;
}

/**
 * Parse a 512-byte tar header
 */
function parseTarHeader(data: Uint8Array, offset: number): TarHeader | null {
  if (offset + 512 > data.length) {
    return null;
  }

  const header = data.slice(offset, offset + 512);

  // Read header fields (all strings are null-terminated)
  const name = readString(header, 0, 100);
  const sizeStr = readString(header, 124, 12);
  const typeflag = readString(header, 156, 1);

  // Parse size (octal)
  const size = parseInt(sizeStr.trim(), 8) || 0;

  // Skip non-regular files
  if (typeflag && typeflag !== '0' && typeflag !== '\0') {
    return null;
  }

  if (!name || size === 0) {
    return null;
  }

  return { name, size };
}

interface TarHeader {
  name: string;
  size: number;
}

/**
 * Read a null-terminated string from a Uint8Array
 */
function readString(data: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && data[end] !== 0) {
    end++;
  }
  return new TextDecoder().decode(data.slice(start, end));
}

/**
 * Check if a 512-byte block is all zeros (end of archive marker)
 */
function isZeroBlock(data: Uint8Array, offset: number): boolean {
  if (offset + 512 > data.length) {
    return true;
  }
  
  for (let i = 0; i < 512; i++) {
    if (data[offset + i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Clean tar archive path:
 * - Remove leading ./
 * - Remove .password-store/ prefix
 * - Remove .gpg suffix
 * 
 * Examples:
 * - ".password-store/Email/gmail.com.gpg" → "Email/gmail.com"
 * - "Email/gmail.com.gpg" → "Email/gmail.com"
 * - "./Email/gmail.com.gpg" → "Email/gmail.com"
 */
function cleanTarPath(path: string): string {
  // Remove leading ./
  let clean = path.replace(/^\.\//, '');
  
  // Remove .password-store/ prefix
  clean = clean.replace(/^\.password-store\//, '');
  
  // Remove .gpg suffix
  clean = clean.replace(/\.gpg$/, '');
  
  // Remove any leading / or ./
  clean = clean.replace(/^[/\.]+/, '');
  
  return clean;
}

/**
 * Validate that a file appears to be a valid tar.gz archive
 */
export function isValidTarGz(file: File): boolean {
  // Check file extension
  const name = file.name.toLowerCase();
  if (!name.endsWith('.tar.gz') && !name.endsWith('.tgz')) {
    return false;
  }

  // Check magic bytes (gzip: 1f 8b)
  // This will be checked when we try to decompress
  return true;
}

/**
 * Count .gpg files in archive without full extraction (for progress estimation)
 */
export async function countGpgFiles(file: File): Promise<number> {
  try {
    const entries = await extractTarGz(file);
    return entries.length;
  } catch {
    return 0;
  }
}
