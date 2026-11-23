import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cards } from '../cards/specs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(__dirname, '..', 'cards');
fs.mkdirSync(outputDir, { recursive: true });

const W = 512;
const H = 768;
const FONT = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) {
        crc ^= buffer[i];
        for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuffer = Buffer.from(type, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function setPixel(buffer, x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const offset = (y * W + x) * 4;
    buffer[offset] = r;
    buffer[offset + 1] = g;
    buffer[offset + 2] = b;
    buffer[offset + 3] = a;
}

function blend(buffer, x, y, r, g, b, alpha) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const offset = (y * W + x) * 4;
    buffer[offset] = Math.round(buffer[offset] * (1 - alpha) + r * alpha);
    buffer[offset + 1] = Math.round(buffer[offset + 1] * (1 - alpha) + g * alpha);
    buffer[offset + 2] = Math.round(buffer[offset + 2] * (1 - alpha) + b * alpha);
    buffer[offset + 3] = 255;
}

function fillRect(buffer, x, y, w, h, r, g, b, alpha = 1) {
    for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) {
            if (alpha >= 1) setPixel(buffer, xx, yy, r, g, b);
            else blend(buffer, xx, yy, r, g, b, alpha);
        }
    }
}

function line(buffer, x0, y0, x1, y1, thickness, r, g, b, alpha = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        fillRect(buffer, x - Math.floor(thickness / 2), y - Math.floor(thickness / 2), thickness, thickness, r, g, b, alpha);
    }
}

function circle(buffer, cx, cy, radius, r, g, b, alpha = 1) {
    for (let y = -radius; y <= radius; y += 1) {
        for (let x = -radius; x <= radius; x += 1) {
            if (x * x + y * y <= radius * radius) blend(buffer, cx + x, cy + y, r, g, b, alpha);
        }
    }
}

function polygon(buffer, points, color, alpha = 1) {
    const [r, g, b] = color;
    const minY = Math.max(0, Math.min(...points.map((point) => point[1])));
    const maxY = Math.min(H - 1, Math.max(...points.map((point) => point[1])));
    for (let y = minY; y <= maxY; y += 1) {
        const intersections = [];
        for (let index = 0; index < points.length; index += 1) {
            const [x1, y1] = points[index];
            const [x2, y2] = points[(index + 1) % points.length];
            if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
                intersections.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
            }
        }
        intersections.sort((a, b) => a - b);
        for (let index = 0; index + 1 < intersections.length; index += 2) {
            for (let x = Math.ceil(intersections[index]); x <= Math.floor(intersections[index + 1]); x += 1) {
                blend(buffer, x, y, r, g, b, alpha);
            }
        }
    }
}

function text(buffer, value, centerX, top, scale, color, alpha = 1) {
    const glyphs = [...value.toUpperCase()];
    const width = glyphs.length * 6 * scale - scale;
    let cursor = centerX - Math.floor(width / 2);
    for (const char of glyphs) {
        const glyph = FONT[char] ?? FONT[' '];
        for (let row = 0; row < 7; row += 1) {
            for (let col = 0; col < 5; col += 1) {
                if (glyph[row][col] === '1') fillRect(buffer, cursor + col * scale, top + row * scale, scale, scale, ...color, alpha);
            }
        }
        cursor += 6 * scale;
    }
}

function makePixels(index, baseColor) {
    const buffer = Buffer.alloc(W * H * 4, 0);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const t = y / H;
            const light = 0.32 + 0.5 * (1 - t);
            const radial = Math.max(0, 1 - Math.hypot(x - W / 2, y - H * 0.45) / 460);
            const r = Math.round(baseColor[0] * light + 34 * radial);
            const g = Math.round(baseColor[1] * light + 30 * radial);
            const b = Math.round(baseColor[2] * light + 38 * radial);
            setPixel(buffer, x, y, Math.min(255, r), Math.min(255, g), Math.min(255, b));
        }
    }
    // frame
    for (let x = 22; x < W - 22; x += 1) {
        setPixel(buffer, x, 22, 238, 224, 188);
        setPixel(buffer, x, 23, 238, 224, 188);
        setPixel(buffer, x, H - 23, 238, 224, 188);
        setPixel(buffer, x, H - 24, 238, 224, 188);
    }
    for (let y = 22; y < H - 22; y += 1) {
        setPixel(buffer, 22, y, 238, 224, 188);
        setPixel(buffer, 23, y, 238, 224, 188);
        setPixel(buffer, W - 23, y, 238, 224, 188);
        setPixel(buffer, W - 24, y, 238, 224, 188);
    }
    // corner ornaments
    for (const [cx, cy] of [[60, 60], [W - 60, 60], [60, H - 60], [W - 60, H - 60]]) {
        circle(buffer, cx, cy, 26, 238, 224, 188, 0.18);
        circle(buffer, cx, cy, 8, 238, 224, 188, 0.75);
    }
    // diagonal texture
    for (let offset = -H; offset < W; offset += 26) {
        line(buffer, offset, 0, offset + H, H, 2, 255, 255, 255, 0.018);
    }
    // emblem
    const cx = W / 2;
    const cy = 340;
    circle(buffer, cx, cy, 142, 12, 15, 24, 0.3);
    circle(buffer, cx, cy, 136, 238, 224, 188, 0.1);

    if (index === 0) {
        circle(buffer, cx, cy - 40, 48, 238, 224, 188, 0.9);
        circle(buffer, cx, cy - 44, 34, 12, 15, 24, 0.9);
        polygon(buffer, [[cx - 110, cy + 120], [cx - 70, cy + 30], [cx, cy + 10], [cx + 70, cy + 30], [cx + 110, cy + 120]], [238, 224, 188], 0.88);
    } else if (index === 1) {
        line(buffer, cx - 78, cy + 110, cx + 78, cy - 110, 20, 238, 224, 188, 0.95);
        line(buffer, cx - 98, cy + 8, cx - 34, cy + 8, 16, 158, 100, 54);
        line(buffer, cx + 34, cy + 8, cx + 98, cy + 8, 16, 158, 100, 54);
        polygon(buffer, [[cx + 78, cy - 152], [cx + 112, cy - 110], [cx + 78, cy - 68], [cx + 44, cy - 110]], [238, 224, 188], 0.9);
    } else if (index === 2) {
        circle(buffer, cx, cy, 96, 98, 210, 255, 0.16);
        circle(buffer, cx, cy, 62, 98, 210, 255, 0.22);
        circle(buffer, cx, cy, 24, 238, 224, 188, 0.95);
        for (let angle = 0; angle < 360; angle += 60) {
            const rad = (angle * Math.PI) / 180;
            circle(buffer, Math.round(cx + Math.cos(rad) * 96), Math.round(cy + Math.sin(rad) * 96), 10, 238, 224, 188, 0.9);
            line(buffer, cx, cy, Math.round(cx + Math.cos(rad) * 96), Math.round(cy + Math.sin(rad) * 96), 3, 238, 224, 188, 0.35);
        }
    } else if (index === 3) {
        polygon(buffer, [[cx - 138, cy + 100], [cx - 48, cy - 82], [cx + 8, cy + 28], [cx + 58, cy - 44], [cx + 148, cy + 100]], [238, 224, 188], 0.82);
        circle(buffer, cx + 88, cy - 90, 24, 255, 219, 120, 0.9);
        line(buffer, cx - 138, cy + 112, cx + 148, cy + 112, 6, 12, 15, 24, 0.7);
    } else if (index === 4) {
        const points = [[cx - 108, cy + 82], [cx - 48, cy], [cx + 10, cy + 42], [cx + 60, cy - 44], [cx + 112, cy - 94]];
        for (let i = 0; i < points.length - 1; i += 1) {
            line(buffer, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], 5, 238, 224, 188, 0.55);
        }
        for (const [x, y] of points) {
            circle(buffer, x, y, 16, 238, 224, 188, 0.95);
            circle(buffer, x, y, 7, 38, 42, 54, 1);
        }
    } else {
        polygon(buffer, [[cx, cy - 120], [cx + 96, cy - 60], [cx + 80, cy + 66], [cx, cy + 120], [cx - 80, cy + 66], [cx - 96, cy - 60]], [238, 224, 188], 0.86);
        fillRect(buffer, cx - 10, cy - 74, 20, 94, 48, 35, 20);
        circle(buffer, cx, cy + 52, 14, 48, 35, 20);
    }

    text(buffer, 'STRPG', W / 2, 74, 7, [238, 224, 188], 0.96);
    text(buffer, 'STUDIO', W / 2, 142, 4, [238, 224, 188], 0.7);
    const labels = ['NPC DESIGNER', 'EQUIPMENT', 'SKILL DESIGNER', 'SCENE DESIGNER', 'STORY ARCHITECT', 'QUEST DESIGNER'];
    text(buffer, labels[index], W / 2, 610, 5, [238, 224, 188], 0.95);
    text(buffer, `CARD 0${index + 1}`, W / 2, 672, 3, [238, 224, 188], 0.65);
    text(buffer, 'STRUCTURED CONTENT', W / 2, 704, 2, [238, 224, 188], 0.45);
    return buffer;
}

function makePng(index, card) {
    const baseColor = card.color;
    const pixels = makePixels(index, baseColor);
    const raw = Buffer.alloc((W * 4 + 1) * H);
    for (let y = 0; y < H; y += 1) {
        raw[y * (W * 4 + 1)] = 0;
        pixels.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const cardJson = JSON.stringify(card.card);
    const chara = Buffer.from(Buffer.from(cardJson, 'utf8').toString('base64'), 'latin1');
    const textChunk = (keyword, value) => {
        const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
        return chunk('tEXt', data);
    };
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        textChunk('Software', 'STRPG Studio Character Card Generator'),
        textChunk('chara', chara.toString('latin1')),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function parsePngChunks(buffer) {
    const signature = buffer.subarray(0, 8);
    if (signature.toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG signature');
    const chunks = [];
    let offset = 8;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        chunks.push({ type, length, data });
        offset += 12 + length;
    }
    return chunks;
}

const manifest = [];
for (const [index, card] of cards.entries()) {
    const number = String(index + 1).padStart(2, '0');
    const stem = `strpg-card-${number}-${card.id.replaceAll('_', '-')}`;
    const jsonPath = path.join(outputDir, `${stem}.json`);
    const pngPath = path.join(outputDir, `${stem}.png`);
    fs.writeFileSync(jsonPath, `${JSON.stringify(card.card, null, 2)}\n`, 'utf8');
    const png = makePng(index, card);
    const chunks = parsePngChunks(png);
    const charaChunk = chunks.find((entry) => entry.type === 'tEXt' && entry.data.subarray(0, 5).toString('latin1') === 'chara');
    if (!charaChunk) throw new Error(`PNG for ${card.name} has no chara metadata`);
    const decoded = JSON.parse(Buffer.from(charaChunk.data.subarray(6).toString('latin1'), 'base64').toString('utf8'));
    if (decoded.data.name !== card.name) throw new Error('Embedded character card name mismatch');
    fs.writeFileSync(pngPath, png);
    manifest.push({
        order: index + 1,
        id: card.id,
        name: card.name,
        role: card.role,
        json: path.basename(jsonPath),
        png: path.basename(pngPath),
        tags: card.tags,
        spec: 'chara_card_v2',
        pngBytes: png.length,
    });
    console.log(`[cards] ${stem}.png (${png.length} bytes), ${stem}.json`);
}
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), cards: manifest }, null, 2)}\n`, 'utf8');
console.log(`[cards] Generated ${manifest.length} Character Card V2 JSON + PNG files.`);
