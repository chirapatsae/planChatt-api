/**
 * pptx-extract.ts
 *
 * Hand-rolled PPTX text extractor with ZERO new deps beyond what's already
 * transitively available. Uses Node's built-in zlib+Buffer to unzip a .pptx
 * file (which is a zip archive of XML parts) and regex-extracts
 * `<a:t>...</a:t>` text nodes from every slide.
 *
 * This is deliberately "good enough" rather than a full PPTX parser:
 *   - no speaker-notes distinction (but slides are enough for the AI summary)
 *   - no font / layout info
 *   - no math / shape content beyond plain text
 *
 * Contract (docs/tasks/DOCUMENT_ANALYSIS_PHASE3_EXPANSION.md §3.2):
 *   - Return a single concatenated string; caller truncates to 8,000 chars.
 *   - Must NOT write any extracted part to disk — parse in memory.
 *
 * If the task author later chooses to add `jszip` / `pptx-parser`, swap this
 * implementation while keeping the public `extractPptxText` signature.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import { readFile } from 'fs/promises';
import { inflateRawSync } from 'zlib';

// Minimal ZIP central-directory reader — enough to pull slide XML parts out
// of a .pptx. Implemented from scratch to avoid pulling a new dep.
function readUInt16LE(buf: Buffer, off: number) {
  return buf.readUInt16LE(off);
}
function readUInt32LE(buf: Buffer, off: number) {
  return buf.readUInt32LE(off);
}

function findEocd(buf: Buffer): number {
  // End of central directory record signature: 0x06054b50
  const sig = 0x06054b50;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65535 - 22); i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function listEntries(buf: Buffer): Array<{
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}> {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('invalid pptx: EOCD not found');
  const total = readUInt16LE(buf, eocd + 10);
  const cdSize = readUInt32LE(buf, eocd + 12);
  const cdOffset = readUInt32LE(buf, eocd + 16);
  type ZipEntry = {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  };
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    // Central directory file header signature 0x02014b50
    if (readUInt32LE(buf, p) !== 0x02014b50) break;
    const method = readUInt16LE(buf, p + 10);
    const compressedSize = readUInt32LE(buf, p + 20);
    const uncompressedSize = readUInt32LE(buf, p + 24);
    const nameLen = readUInt16LE(buf, p + 28);
    const extraLen = readUInt16LE(buf, p + 30);
    const commentLen = readUInt16LE(buf, p + 32);
    const localHeaderOffset = readUInt32LE(buf, p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) break;
  }
  return entries;
}

function readEntry(
  buf: Buffer,
  entry: ReturnType<typeof listEntries>[number],
): Buffer {
  // Local file header signature 0x04034b50
  const off = entry.localHeaderOffset;
  if (readUInt32LE(buf, off) !== 0x04034b50) {
    throw new Error(`invalid pptx: local header for ${entry.name}`);
  }
  const nameLen = readUInt16LE(buf, off + 26);
  const extraLen = readUInt16LE(buf, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compressed = buf.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip method ${entry.method} for ${entry.name}`);
}

const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide\d+\.xml$/;
const TEXT_TAG_RE = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    );
}

function extractTextFromXml(xml: string): string {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TEXT_TAG_RE.exec(xml))) {
    const raw = m[1] ?? '';
    const decoded = decodeXmlEntities(raw).trim();
    if (decoded) out.push(decoded);
  }
  return out.join(' ');
}

export async function extractPptxText(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const entries = listEntries(buf);

  // Order slides by the numeric suffix so the output is stable.
  const slideEntries = entries
    .filter((e) => SLIDE_RE.test(e.name))
    .sort((a, b) => {
      const an = parseInt(a.name.replace(/\D+/g, ''), 10) || 0;
      const bn = parseInt(b.name.replace(/\D+/g, ''), 10) || 0;
      return an - bn;
    });

  const noteEntries = entries
    .filter((e) => NOTES_RE.test(e.name))
    .sort((a, b) => {
      const an = parseInt(a.name.replace(/\D+/g, ''), 10) || 0;
      const bn = parseInt(b.name.replace(/\D+/g, ''), 10) || 0;
      return an - bn;
    });

  const parts: string[] = [];
  for (let i = 0; i < slideEntries.length; i++) {
    const xml = readEntry(buf, slideEntries[i]).toString('utf8');
    const text = extractTextFromXml(xml);
    if (text) parts.push(`# Slide ${i + 1}\n${text}`);
  }
  for (let i = 0; i < noteEntries.length; i++) {
    const xml = readEntry(buf, noteEntries[i]).toString('utf8');
    const text = extractTextFromXml(xml);
    if (text) parts.push(`# Notes ${i + 1}\n${text}`);
  }

  return parts.join('\n\n').trim();
}
