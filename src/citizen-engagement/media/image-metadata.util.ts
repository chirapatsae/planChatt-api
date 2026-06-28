/**
 * image-metadata.util — PDPA / plan-D10 PRIVACY strip.
 *
 * EVERY uploaded image MUST have its metadata stripped BEFORE it is persisted,
 * so GPS/EXIF can NEVER survive to the served file. This is DEPENDENCY-FREE:
 * no `sharp` / `exif` lib is installed and NONE may be added. We rebuild the
 * container byte-stream and DROP the metadata-carrying segments by hand.
 *
 * The companion spec (image-metadata.util.spec.ts) is the PRIVACY PROOF — it
 * crafts an EXIF APP1 / tEXt marker and asserts the stripped output no longer
 * contains it. That spec MUST pass.
 *
 * Pure functions, no I/O. Unknown/garbled input THROWS so the caller can 400.
 */

const JPEG_SOI = 0xffd8;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Strip EXIF/GPS/XMP/text metadata from a JPEG or PNG buffer.
 *
 * @throws Error when the buffer is not a recognised / well-formed JPEG or PNG.
 */
export function stripImageMetadata(buf: Buffer, contentType: string): Buffer {
  if (contentType === 'image/jpeg') {
    return stripJpeg(buf);
  }
  if (contentType === 'image/png') {
    return stripPng(buf);
  }
  throw new Error('CITIZEN_MEDIA_UNSUPPORTED_TYPE');
}

/**
 * JPEG: copy SOI (FFD8); walk segment markers; DROP APP1..APPF
 * (FFE1..FFEF — EXIF / XMP / etc); KEEP APP0/JFIF (FFE0) and every non-APP
 * segment; once SOS (FFDA) is reached, copy the remainder verbatim to EOI.
 */
function stripJpeg(buf: Buffer): Buffer {
  if (buf.length < 2 || buf.readUInt16BE(0) !== JPEG_SOI) {
    throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
  }

  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let i = 2;

  while (i + 1 < buf.length) {
    // Every marker begins with 0xFF; skip any fill bytes.
    if (buf[i] !== 0xff) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
    }
    let markerByte = buf[i + 1];
    let markerPos = i;
    while (markerByte === 0xff && markerPos + 2 < buf.length) {
      // Padding 0xFF run before the real marker byte.
      markerPos += 1;
      markerByte = buf[markerPos + 1];
    }

    const marker = buf.readUInt16BE(markerPos);

    // Start-of-Scan: copy everything from here to EOI verbatim (entropy-coded data).
    if (marker === 0xffda) {
      out.push(buf.subarray(markerPos));
      return Buffer.concat(out);
    }

    // Standalone markers (no length payload): RSTn / TEM. Defensive — rare pre-SOS.
    if (
      marker === 0xff01 ||
      (marker >= 0xffd0 && marker <= 0xffd7)
    ) {
      out.push(buf.subarray(markerPos, markerPos + 2));
      i = markerPos + 2;
      continue;
    }

    // Length-bearing segment: 2-byte big-endian length INCLUDES the length bytes.
    const lenPos = markerPos + 2;
    if (lenPos + 2 > buf.length) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
    }
    const segLen = buf.readUInt16BE(lenPos);
    const segEnd = lenPos + segLen;
    if (segLen < 2 || segEnd > buf.length) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
    }

    const isAppN = marker >= 0xffe0 && marker <= 0xffef;
    const isMetadataApp = marker >= 0xffe1 && marker <= 0xffef; // DROP APP1..APPF
    if (!isAppN || !isMetadataApp) {
      // KEEP: APP0/JFIF (FFE0) and every non-APP segment (DQT, DHT, SOF, ...).
      out.push(buf.subarray(markerPos, segEnd));
    }
    // else: DROP this APP1..APPF metadata segment entirely.

    i = segEnd;
  }

  throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
}

/**
 * Read the pixel dimensions of a JPEG or PNG from raw header bytes (no lib).
 *
 * DECOMPRESSION-BOMB GUARD (W-M1): the strip util faithfully rebuilds whatever
 * container it is given — a tiny file can still declare enormous dimensions and
 * blow up any downstream renderer/thumbnailer that trusts the header. The caller
 * inspects these dimensions BEFORE strip/persist and rejects oversized images.
 *
 *  - PNG: IHDR is the first chunk; width = uint32 BE @ offset 16,
 *    height = uint32 BE @ offset 20 (signature 8 + len 4 + 'IHDR' 4 = data @16).
 *  - JPEG: scan segment markers for a Start-Of-Frame (SOF0/SOF1/SOF2 =
 *    0xFFC0/0xFFC1/0xFFC2); height = uint16 BE @ marker+5, width = uint16 BE @
 *    marker+7. Throw if no SOF is found.
 *
 * @throws Error when the buffer is not a recognised / well-formed JPEG or PNG,
 *         so the caller can map the failure to the existing 400.
 */
export function readImageDimensions(
  buf: Buffer,
  contentType: string,
): { width: number; height: number } {
  let dims: { width: number; height: number };
  if (contentType === 'image/png') {
    dims = readPngDimensions(buf);
  } else if (contentType === 'image/jpeg') {
    dims = readJpegDimensions(buf);
  } else {
    throw new Error('CITIZEN_MEDIA_UNSUPPORTED_TYPE');
  }
  // A zero/negative dimension is a degenerate, unrenderable image — reject it
  // here so every caller (post media + stories) gets the guard for free.
  if (dims.width <= 0 || dims.height <= 0) {
    throw new Error('CITIZEN_MEDIA_ZERO_DIMENSION');
  }
  return dims;
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  // signature(8) + IHDR length(4) + 'IHDR'(4) + width(4) @16 + height(4) @20.
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('CITIZEN_MEDIA_MALFORMED_PNG');
  }
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('CITIZEN_MEDIA_MALFORMED_PNG');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 2 || buf.readUInt16BE(0) !== JPEG_SOI) {
    throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
  }

  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
    }
    // Skip any 0xFF fill bytes that precede the real marker byte.
    let markerPos = i;
    while (buf[markerPos + 1] === 0xff && markerPos + 2 < buf.length) {
      markerPos += 1;
    }

    const marker = buf.readUInt16BE(markerPos);

    // Any Start-Of-Frame marker carries the dimensions. SOF0..SOF15 span
    // 0xFFC0-0xFFCF EXCEPT 0xFFC4 (DHT), 0xFFC8 (JPG), 0xFFCC (DAC) — those are
    // not frame headers. Covers baseline + progressive + the rarer
    // extended/lossless/differential/arithmetic encodings (FAIL-SAFE either way:
    // an unmeasured image is rejected, never stored unmeasured).
    if (
      marker >= 0xffc0 &&
      marker <= 0xffcf &&
      marker !== 0xffc4 &&
      marker !== 0xffc8 &&
      marker !== 0xffcc
    ) {
      // SOF payload: len(2) precision(1) height(2)@+5 width(2)@+7.
      if (markerPos + 9 > buf.length) {
        throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
      }
      const height = buf.readUInt16BE(markerPos + 5);
      const width = buf.readUInt16BE(markerPos + 7);
      return { width, height };
    }

    // Reached entropy-coded scan before any SOF — no dimensions to read.
    if (marker === 0xffda) {
      throw new Error('CITIZEN_MEDIA_NO_SOF');
    }

    // Standalone markers (no length payload): RSTn / TEM.
    if (marker === 0xff01 || (marker >= 0xffd0 && marker <= 0xffd7)) {
      i = markerPos + 2;
      continue;
    }

    // Length-bearing segment: skip its declared length to reach the next marker.
    const lenPos = markerPos + 2;
    if (lenPos + 2 > buf.length) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
    }
    const segLen = buf.readUInt16BE(lenPos);
    if (segLen < 2 || lenPos + segLen > buf.length) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_JPEG');
    }
    i = lenPos + segLen;
  }

  throw new Error('CITIZEN_MEDIA_NO_SOF');
}

/** Ancillary metadata chunks to DROP (privacy / non-rendering). */
const PNG_DROP_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/**
 * PNG: copy signature; walk length/type/data/crc chunks; DROP ancillary
 * metadata chunks (tEXt, zTXt, iTXt, eXIf, tIME); KEEP everything else
 * (IHDR / PLTE / IDAT / IEND / tRNS / gAMA / cHRM / sRGB / bKGD / pHYs ...);
 * stop after IEND.
 */
function stripPng(buf: Buffer): Buffer {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('CITIZEN_MEDIA_MALFORMED_PNG');
  }

  const out: Buffer[] = [buf.subarray(0, 8)]; // signature
  let i = 8;

  while (i + 8 <= buf.length) {
    const dataLen = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const chunkEnd = i + 12 + dataLen; // length(4) + type(4) + data + crc(4)
    if (chunkEnd > buf.length) {
      throw new Error('CITIZEN_MEDIA_MALFORMED_PNG');
    }

    if (!PNG_DROP_CHUNKS.has(type)) {
      out.push(buf.subarray(i, chunkEnd));
    }
    // else: DROP this metadata chunk entirely.

    i = chunkEnd;

    if (type === 'IEND') {
      return Buffer.concat(out);
    }
  }

  throw new Error('CITIZEN_MEDIA_MALFORMED_PNG');
}
