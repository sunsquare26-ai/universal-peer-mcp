// The screenshot, and the reason it can ship at all.
//
// Design 354 asks for a sanitized screenshot beside the demo, and design 429 asks that any PNG
// be checked by OCR and by its metadata. A capture of a real screen cannot pass either: it
// carries a menu bar, an account name, a window title, other session names and a home path,
// and none of that is reviewable. So the picture is not captured, it is drawn — from
// fixtures/demo-ack/session.json, by the code below, with a font that is in this file — and it
// is drawn the same way every time, byte for byte, on any machine.
//
// That is what makes the OCR requirement real rather than decorative. The decoder here reads
// the pixels back, recovers the text, and then re-draws that text and compares every pixel: an
// image that carries one mark the recovered text does not account for is refused. It is not
// general purpose OCR and does not claim to be; it is a complete account of a picture this
// repository produced. The metadata check is exact for the same reason — the chunk list must
// be IHDR, PLTE, IDAT, IEND and nothing else, so there is no tEXt, no iTXt, no eXIf and no
// tIME to strip.
//
// The compressor writes stored deflate blocks on purpose. zlib output is not identical across
// versions, and a picture that has to be reproduced byte for byte cannot depend on which zlib
// the person running the test happens to have.

// 5x7 glyphs for every printable ASCII character, one line each: the code point, then seven
// rows of five.
const GLYPH_ROWS = `
  20 ...................................
  21 ..#....#....#....#....#.........#..
  22 .#.#..#.#..........................
  23 .#.#..#.#.#####.#.#.#####.#.#..#.#.
  24 ..#...#####.#...###...#.#####...#..
  25 ##...##..#...#...#...#...#..##...##
  26 .##..#..#.#.#...#...#.#.##..#..##.#
  27 ..#....#...........................
  28 ...#...#...#....#....#.....#.....#.
  29 .#.....#.....#....#....#...#...#...
  2a .....#.#.#.###.#####.###.#.#.#.....
  2b .......#....#..#####..#....#.......
  2c .....................##....#...#...
  2d ...............#####...............
  2e ..........................##...##..
  2f ....#...#....#...#...#....#...#....
  30 .###.#...##..###.#.###..##...#.###.
  31 ..#...##....#....#....#....#...###.
  32 .###.#...#....#...#...#...#...#####
  33 #####...#...#.....#.....##...#.###.
  34 ...#...##..#.#.#..#.#####...#....#.
  35 ######....####.....#....##...#.###.
  36 ..##..#...#....####.#...##...#.###.
  37 #####....#...#...#...#....#....#...
  38 .###.#...##...#.###.#...##...#.###.
  39 .###.#...##...#.####....#...#..##..
  3a ......##...##........##...##.......
  3b ......##...##........##....#...#...
  3c ...#...#...#...#.....#.....#.....#.
  3d ..........#####.....#####..........
  3e .#.....#.....#.....#...#...#...#...
  3f .###.#...#....#...#...#.........#..
  40 .###.#...#....##.##.#.#.##.#.#.##..
  41 ..#...#.#.#...##...#######...##...#
  42 ####.#...##...#####.#...##...#####.
  43 .###.#...##....#....#....#...#.###.
  44 ###..#..#.#...##...##...##..#.###..
  45 ######....#....####.#....#....#####
  46 ######....#....####.#....#....#....
  47 .###.#...##....#..###...##...#.####
  48 #...##...##...#######...##...##...#
  49 .###...#....#....#....#....#...###.
  4a ..###...#....#....#....#.#..#..##..
  4b #...##..#.#.#..##...#.#..#..#.#...#
  4c #....#....#....#....#....#....#####
  4d #...###.###.#.##.#.##...##...##...#
  4e #...##...###..##.#.##..###...##...#
  4f .###.#...##...##...##...##...#.###.
  50 ####.#...##...#####.#....#....#....
  51 .###.#...##...##...##.#.##..#..##.#
  52 ####.#...##...#####.#.#..#..#.#...#
  53 .#####....#.....###.....#....#####.
  54 #####..#....#....#....#....#....#..
  55 #...##...##...##...##...##...#.###.
  56 #...##...##...##...##...#.#.#...#..
  57 #...##...##...##.#.##.#.###.###...#
  58 #...##...#.#.#...#...#.#.#...##...#
  59 #...##...#.#.#...#....#....#....#..
  5a #####....#...#...#...#...#....#####
  5b .###..#....#....#....#....#....###.
  5c #.....#....#.....#.....#....#.....#
  5d .###....#....#....#....#....#..###.
  5e ..#...#.#.#...#....................
  5f ..............................#####
  60 .#.....#...........................
  61 ...........###.....#.#####...#.####
  62 #....#....####.#...##...##...#####.
  63 ...........###.#....#....#.....###.
  64 ....#....#.#####...##...##...#.####
  65 ...........###.#...#######.....###.
  66 ..##..#..#.#...####..#....#....#...
  67 ......#####...##...#.####....#.###.
  68 #....#....####.#...##...##...##...#
  69 ..#........##....#....#....#...###.
  6a ...#........##....#....#.#..#..##..
  6b #....#....#..#.#.#..##...#.#..#..#.
  6c .##....#....#....#....#....#...###.
  6d ..........##.#.#.#.##.#.##.#.##...#
  6e ..........####.#...##...##...##...#
  6f ...........###.#...##...##...#.###.
  70 ..........####.#...#####.#....#....
  71 ...........#####...#.####....#....#
  72 ..........#.##.##..##....#....#....
  73 ...........#####.....###.....#####.
  74 .#....#...####..#....#....#..#..##.
  75 ..........#...##...##...##..##.##.#
  76 ..........#...##...##...#.#.#...#..
  77 ..........#...##...##.#.##.#.#.#.#.
  78 ..........#...#.#.#...#...#.#.#...#
  79 ..........#...##...#.####....#.###.
  7a ..........#####...#...#...#...#####
  7b ...##..#....#...#.....#....#.....##
  7c ..#....#....#....#....#....#....#..
  7d ##.....#....#.....#...#....#..##...
  7e ......#..##.#.##..#................
`;

export const CELL_WIDTH = 6;
export const CELL_HEIGHT = 9;
export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
export const MARGIN = 4;
export const SCALE = 2;
export const COLS = 62;
export const BACKGROUND = [0x14, 0x16, 0x1a];
export const FOREGROUND = [0xe8, 0xe8, 0xe8];

export const FONT = new Map();
const BY_PATTERN = new Map();
for (const line of GLYPH_ROWS.trim().split("\n")) {
  const [code, pattern] = line.trim().split(" ");
  if (pattern.length !== GLYPH_WIDTH * GLYPH_HEIGHT || /[^.#]/.test(pattern)) throw new Error("bad glyph row");
  const character = String.fromCharCode(Number.parseInt(code, 16));
  if (FONT.has(character) || BY_PATTERN.has(pattern)) throw new Error("duplicate glyph");
  FONT.set(character, pattern); BY_PATTERN.set(pattern, character);
}
if (FONT.size !== 95) throw new Error("the font must cover every printable ascii character");

export function wrap(value, width) {
  const parts = []; let line = "";
  for (const word of value.split(" ")) {
    if (line && `${line} ${word}`.length > width) { parts.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) parts.push(line);
  return parts;
}

// Every value on the screen comes out of the fixture, so the picture cannot drift away from
// the transcript beside it.
export function composeScreen(fixture) {
  const field = (label, value) => `  ${label.padEnd(11)}${value}`;
  const rule = ` ${"-".repeat(COLS - 3)}`;
  const body = wrap(fixture.request.body, COLS - 15);
  const lines = [
    `  peer session  ${fixture.alias}`,
    rule,
    "  peer_send",
    field("messageId", fixture.request.messageId),
    field("threadId", fixture.threadId),
    field("kind", fixture.request.kind),
    field("body", body[0]),
    ...body.slice(1).map((part) => field("", part)),
    rule,
    "  PEER_ACK",
    field("reply_to", fixture.request.messageId),
    "  PEER_REPLY",
    field("verdict", fixture.reply.verdict),
    field("body", fixture.reply.body),
    rule,
    "  peer_wait    require=reply, and nothing is ever resent"
  ];
  for (const line of lines) {
    if (line.length > COLS) throw new Error(`screen line is wider than the screen: ${line.length}`);
    for (const character of line) if (!FONT.has(character)) throw new Error("screen line has a character the font does not cover");
  }
  return lines.map((line) => line.padEnd(COLS));
}

export function screenSize(rows) {
  return { width: (COLS * CELL_WIDTH + MARGIN * 2) * SCALE, height: (rows * CELL_HEIGHT + MARGIN * 2) * SCALE };
}

// one byte per pixel, 0 background and 1 foreground, before the picture is packed into bits
export function paint(lines) {
  const { width, height } = screenSize(lines.length);
  const pixels = new Uint8Array(width * height);
  lines.forEach((line, row) => {
    [...line].forEach((character, column) => {
      const pattern = FONT.get(character);
      for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
        for (let x = 0; x < GLYPH_WIDTH; x += 1) {
          if (pattern[y * GLYPH_WIDTH + x] !== "#") continue;
          const left = (MARGIN + column * CELL_WIDTH + x) * SCALE;
          const top = (MARGIN + row * CELL_HEIGHT + 1 + y) * SCALE;
          for (let dy = 0; dy < SCALE; dy += 1) for (let dx = 0; dx < SCALE; dx += 1) pixels[(top + dy) * width + left + dx] = 1;
        }
      }
    });
  });
  return { pixels, width, height };
}

export function encodePng(lines) { return encodeImage(paint(lines)); }

// extras exists so a test can build the pictures this repository refuses: one with a comment
// chunk, one with a pixel that no letter accounts for.
export function encodeImage({ pixels, width, height }, extras = []) {
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1);
    raw[start] = 0;                                                  // filter: none, every row
    for (let x = 0; x < width; x += 1) if (pixels[y * width + x]) raw[start + 1 + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 1; header[9] = 3; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", Buffer.from([...BACKGROUND, ...FOREGROUND])),
    ...extras.map(([type, payload]) => chunk(type, payload)),
    chunk("IDAT", storedDeflate(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("not a png");
  const chunks = []; let offset = 8; let header = null; let palette = null; const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) throw new Error(`chunk ${type} is corrupt`);
    chunks.push(type);
    if (type === "IHDR") header = { width: payload.readUInt32BE(0), height: payload.readUInt32BE(4), depth: payload[8], colour: payload[9], compression: payload[10], filter: payload[11], interlace: payload[12] };
    if (type === "PLTE") palette = [...payload];
    if (type === "IDAT") data.push(payload);
    offset += 12 + length;
  }
  if (!header || header.depth !== 1 || header.colour !== 3 || header.interlace !== 0) throw new Error("unsupported png");
  const raw = inflateStored(Buffer.concat(data));
  const rowBytes = Math.ceil(header.width / 8);
  if (raw.length !== (rowBytes + 1) * header.height) throw new Error("png pixel data has the wrong length");
  const pixels = new Uint8Array(header.width * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const start = y * (rowBytes + 1);
    if (raw[start] !== 0) throw new Error("png uses a row filter this reader does not accept");
    for (let x = 0; x < header.width; x += 1) pixels[y * header.width + x] = (raw[start + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
  }
  return { ...header, chunks, palette, pixels };
}

// Read the text back out of the pixels, then redraw it and compare every pixel. Anything the
// recovered text does not explain — a mark between two letters, a line below the last one — is
// a refusal, not a rounding error.
export function readScreen(bytes) {
  const image = decodePng(bytes);
  const rows = (image.height / SCALE - MARGIN * 2) / CELL_HEIGHT;
  if (!Number.isInteger(rows) || image.width !== screenSize(rows).width) throw new Error("png is not a screen this reader drew");
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let column = 0; column < COLS; column += 1) {
      let pattern = "";
      for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
        for (let x = 0; x < GLYPH_WIDTH; x += 1) {
          const left = (MARGIN + column * CELL_WIDTH + x) * SCALE;
          const top = (MARGIN + row * CELL_HEIGHT + 1 + y) * SCALE;
          const value = image.pixels[top * image.width + left];
          for (let dy = 0; dy < SCALE; dy += 1) for (let dx = 0; dx < SCALE; dx += 1) {
            if (image.pixels[(top + dy) * image.width + left + dx] !== value) throw new Error("png pixels are not the blocks this reader drew");
          }
          pattern += value ? "#" : ".";
        }
      }
      const character = BY_PATTERN.get(pattern);
      if (character === undefined) throw new Error(`png cell ${row},${column} is not a character in the font`);
      line += character;
    }
    lines.push(line);
  }
  const redrawn = paint(lines).pixels;
  if (Buffer.compare(Buffer.from(redrawn), Buffer.from(image.pixels)) !== 0) throw new Error("png carries marks the recovered text does not account for");
  return lines;
}

function chunk(type, payload) {
  const head = Buffer.alloc(4); head.writeUInt32BE(payload.length, 0);
  const named = Buffer.concat([Buffer.from(type, "latin1"), payload]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(named), 0);
  return Buffer.concat([head, named, tail]);
}

function storedDeflate(raw) {
  const parts = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < raw.length; offset += 0xffff) {
    const slice = raw.subarray(offset, offset + 0xffff);
    const head = Buffer.alloc(5);
    head[0] = offset + 0xffff >= raw.length ? 1 : 0;
    head.writeUInt16LE(slice.length, 1); head.writeUInt16LE(~slice.length & 0xffff, 3);
    parts.push(head, slice);
  }
  const sum = Buffer.alloc(4); sum.writeUInt32BE(adler32(raw), 0);
  return Buffer.concat([...parts, sum]);
}

function inflateStored(bytes) {
  if (bytes[0] !== 0x78 || bytes[1] !== 0x01) throw new Error("unexpected zlib header");
  const parts = []; let offset = 2;
  for (;;) {
    const head = bytes[offset];
    if ((head >> 1) & 3) throw new Error("this reader only accepts stored deflate blocks");
    const length = bytes.readUInt16LE(offset + 1);
    if ((~length & 0xffff) !== bytes.readUInt16LE(offset + 3)) throw new Error("stored block length is inconsistent");
    parts.push(bytes.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    if (head & 1) break;
  }
  const raw = Buffer.concat(parts);
  if (bytes.readUInt32BE(offset) !== adler32(raw)) throw new Error("zlib checksum mismatch");
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
  let a = 1; let b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
