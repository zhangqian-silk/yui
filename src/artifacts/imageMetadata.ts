import { extname } from "node:path";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export function isRasterArtifact(path: string) {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase());
}

/** Bounded raster metadata inspection, not a decoder. The viewer also reports
 * browser decode errors. Never admit SVG/HTML or trust a caller's MIME type. */
export function rasterMetadata(bytes: Buffer) {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 4 MiB.");
  let mime: string, width = 0, height = 0;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(8) === 13) {
    mime = "image/png";
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let end = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) throw new Error("Truncated PNG image.");
      if (type === "acTL") throw new Error("Animated images are unsupported; save a static frame.");
      offset += length + 12;
      if (type === "IEND") { end = length === 0 && offset === bytes.length; break; }
    }
    if (!end) throw new Error("Incomplete PNG image.");
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error("Invalid JPEG image marker.");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) throw new Error("Truncated JPEG image.");
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error("Truncated JPEG image.");
      if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
        if (length < 8) throw new Error("Invalid JPEG image frame.");
        if (width || height) throw new Error("Multiple JPEG image frames are unsupported.");
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw new Error("Incomplete JPEG image.");
  } else if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    mime = "image/webp";
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      if (bytes[20]! & 2) throw new Error("Animated images are unsupported; save a static frame.");
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 47) {
      width = 1 + (bytes.readUInt32LE(21) & 0x3fff);
      height = 1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff);
    }
    let frames = 0;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new Error("Truncated WebP image.");
      const length = bytes.readUInt32LE(offset + 4);
      const type = bytes.toString("ascii", offset, offset + 4);
      if (type === "ANIM" || type === "ANMF") throw new Error("Animated images are unsupported; save a static frame.");
      if (offset + 8 + length > bytes.length) throw new Error("Truncated WebP image.");
      if (type === "VP8 " || type === "VP8L") {
        let frameWidth = 0, frameHeight = 0;
        if (type === "VP8 " && length >= 10
          && bytes.subarray(offset + 11, offset + 14).equals(Buffer.from([157, 1, 42]))) {
          frameWidth = bytes.readUInt16LE(offset + 14) & 0x3fff;
          frameHeight = bytes.readUInt16LE(offset + 16) & 0x3fff;
        } else if (type === "VP8L" && length >= 5 && bytes[offset + 8] === 47) {
          frameWidth = 1 + (bytes.readUInt32LE(offset + 9) & 0x3fff);
          frameHeight = 1 + ((bytes.readUInt32LE(offset + 9) >>> 14) & 0x3fff);
        }
        if (frameWidth !== width || frameHeight !== height || ++frames > 1) {
          throw new Error("Invalid WebP image frame dimensions.");
        }
      }
      offset += 8 + length + (length % 2);
      if (offset > bytes.length) throw new Error("Truncated WebP image.");
    }
    if (frames !== 1) throw new Error("WebP image has no readable frame.");
  } else {
    throw new Error("Unsupported or damaged image. Use static PNG, JPEG or WebP (not SVG/GIF).");
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) {
    throw new Error("Unsupported image dimensions: maximum 8192 per side and 16 million pixels.");
  }
  return { mime, width, height };
}
