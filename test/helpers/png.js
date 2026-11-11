/**
 * @file test/helpers/png.js
 * @module test/helpers/png
 * @purpose Build a valid solid-color PNG of an exact pixel size, so tests can state the size of a
 *   reference file instead of trusting a 1x1 stub whose frame disagrees with every mock answer.
 * @depends node:zlib
 * @usedBy test/advanced, test/team
 * @exports pngOf
 * @ai.tags testing, images
 * @ai.hint pure
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function crc32(buf) {
    let crc = -1;
    for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), out.length - 4);
    return out;
}

/**
 * A solid RGBA PNG of the given size.
 * @param {number} width
 * @param {number} height
 * @param {number[]} [rgba]
 * @returns {Buffer}
 * @exports
 * @ai.hint pure
 */
export function pngOf(width, height, rgba = [255, 0, 0, 255]) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type: RGBA
    const stride = 1 + width * 4;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * stride + 1;
        for (let x = 0; x < width; x += 1) raw.set(rgba, row + x * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
