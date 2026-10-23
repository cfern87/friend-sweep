// Minimal, dependency-free ZIP writer.
//
// WHY not a library or a shell command:
//   - PowerShell's Compress-Archive (the obvious Windows choice) writes
//     subdirectory entries with BACKSLASH separators — `icons\icon16.png`.
//     The ZIP spec mandates forward slashes, and Chrome fails to resolve the
//     mis-separated paths, so the icons silently go missing from the package.
//   - `zip` isn't installed on Windows by default, so the release step would
//     only work on some machines.
//   - Pulling in an archiver package for ~100 lines of well-specified format
//     mechanics isn't worth the dependency.
//
// This writer contributes NO nondeterminism of its own: entries carry a fixed
// timestamp and are written in the order given (the caller sorts them), so
// identical input bytes always produce an identical archive — re-packaging an
// unchanged version yields a byte-identical upload.
//
// Scope: no Zip64, no encryption, no data descriptors. An unpacked extension is
// a handful of small files, far below every 32-bit limit in the format.

import { deflateRawSync } from 'zlib';

// Fixed MS-DOS timestamp: 2000-01-01 00:00:00. Deliberately not "now" — see the
// determinism note above. Date = (year-1980)<<9 | month<<5 | day.
const DOS_TIME = 0;
const DOS_DATE = (2000 - 1980) << 9 | 1 << 5 | 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {{name: string, data: Buffer}[]} files
 *   `name` is the in-archive path and MUST use forward slashes — that is the
 *   whole point of this module, so it is asserted rather than normalized.
 * @returns {Buffer}
 */
export function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    if (name.includes('\\')) {
      throw new Error(`ZIP entry name must use forward slashes, got: ${name}`);
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });

    // Store verbatim when deflating doesn't pay. PNGs are already compressed,
    // so deflate typically makes them slightly larger.
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract (2.0)
    local.writeUInt16LE(0, 6);            // general purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    localParts.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed to extract
    central.writeUInt16LE(0, 8);          // general purpose flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra field length
    central.writeUInt16LE(0, 32);         // file comment length
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal file attributes
    // External attributes: regular file, mode 0644, in the high 16 bits.
    // Multiplied rather than shifted — `0o100644 << 16` overflows JS's signed
    // 32-bit bitwise result and would come out negative.
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);    // relative offset of local header
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralDir = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // end of central directory signature
  eocd.writeUInt16LE(0, 4);               // this disk number
  eocd.writeUInt16LE(0, 6);               // disk with start of central dir
  eocd.writeUInt16LE(files.length, 8);    // entries on this disk
  eocd.writeUInt16LE(files.length, 10);   // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);         // central dir offset
  eocd.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}
