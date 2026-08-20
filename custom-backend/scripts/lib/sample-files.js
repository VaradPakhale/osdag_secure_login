/**
 * Generates genuinely valid, openable sample files for the seed. [ADR-0013]
 *
 * Every generator returns a Buffer, and every output really is a file of the
 * type its extension claims — a reviewer can double-click the downloaded PDF
 * and read it, open the PNG in an image viewer, open the .docx in Word.
 *
 * Each file carries text naming its owner, so opening one is itself the
 * isolation demo: if Bob ever manages to download Alice's resume, the document
 * says "Alice Nakamura" in it.
 *
 * All four libraries are pure JavaScript with no native build step, for the
 * same reason argon2 is @node-rs/argon2 — a reviewer who cannot `npm install`
 * cannot review. [ADR-0011]
 */
import jpeg from 'jpeg-js';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const TASK = 'FOSSEE / Osdag (IIT Bombay) screening task';

/** The identifying lines every generated file carries, in type-appropriate form. */
function describe(file, owner) {
  return [
    `${owner.profile.fullName} — ${file.fileName}`,
    `Seeded test document for the ${TASK}.`,
    '',
    `Owner:    ${owner.profile.fullName} <${owner.email}>`,
    `User ID:  ${owner.id}`,
    `File ID:  ${file.id}`,
    `Type:     ${file.mimeType}`,
    `Uploaded: ${file.uploadedAt}`,
    '',
    'This file belongs to exactly one account. If you are reading it while',
    `signed in as anyone other than ${owner.email}, data isolation has failed.`,
  ];
}

// ----------------------------------------------------------------- PDF ----
async function makePdf(file, owner) {
  const doc = await PDFDocument.create();

  doc.setTitle(`${file.fileName} — ${owner.profile.fullName}`);
  doc.setAuthor(`${owner.profile.fullName} <${owner.email}>`);
  doc.setSubject(`Seeded test document for the ${TASK}`);
  doc.setCreator('osdag-secure-login seed script');
  doc.setProducer('pdf-lib');

  const page = doc.addPage([595.28, 841.89]); // A4
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const left = 56;
  let y = 780;

  page.drawText(owner.profile.fullName, { x: left, y, size: 22, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 26;
  page.drawText(file.fileName, { x: left, y, size: 14, font: body, color: rgb(0.35, 0.35, 0.35) });
  y -= 14;

  page.drawLine({
    start: { x: left, y },
    end: { x: 539, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 34;

  page.drawText(`Seeded test document for the`, { x: left, y, size: 11, font: body });
  y -= 15;
  page.drawText(TASK + '.', { x: left, y, size: 11, font: body });
  y -= 34;

  for (const [label, value] of [
    ['Owner', `${owner.profile.fullName} <${owner.email}>`],
    ['User ID', owner.id],
    ['File ID', file.id],
    ['Declared type', file.mimeType],
    ['Uploaded', file.uploadedAt],
  ]) {
    page.drawText(`${label}:`, { x: left, y, size: 10, font: bold });
    page.drawText(value, { x: left + 96, y, size: 10, font: mono });
    y -= 17;
  }

  y -= 22;
  page.drawText('This file belongs to exactly one account. If you are reading it', {
    x: left, y, size: 10, font: body, color: rgb(0.55, 0.1, 0.1),
  });
  y -= 14;
  page.drawText(`while signed in as anyone other than ${owner.email},`, {
    x: left, y, size: 10, font: body, color: rgb(0.55, 0.1, 0.1),
  });
  y -= 14;
  page.drawText('data isolation has failed.', {
    x: left, y, size: 10, font: body, color: rgb(0.55, 0.1, 0.1),
  });

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------- text ----
function makeText(file, owner) {
  const lines = describe(file, owner);
  const rule = '='.repeat(70);
  return Buffer.from([rule, lines[0], rule, '', ...lines.slice(1), ''].join('\n'), 'utf8');
}

// --------------------------------------------------------------- images ----
// A deterministic per-owner colour, so the three accounts are visually distinct
// at a glance in a file browser's thumbnails.
function ownerColour(owner) {
  const n = Number.parseInt(owner.id.replace(/\D/g, ''), 10) || 1;
  const palette = [
    [46, 105, 168],  // blue
    [168, 92, 46],   // amber
    [58, 138, 92],   // green
  ];
  return palette[(n - 1) % palette.length];
}

function drawBands(width, height, [r, g, b], bandCount) {
  const data = Buffer.alloc(width * height * 4);
  const bandHeight = Math.max(1, Math.floor(height / bandCount));

  for (let y = 0; y < height; y += 1) {
    // Alternating light/dark bands; the count identifies the user index.
    const shade = Math.floor(y / bandHeight) % 2 === 0 ? 1 : 0.62;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = Math.round(r * shade);
      data[i + 1] = Math.round(g * shade);
      data[i + 2] = Math.round(b * shade);
      data[i + 3] = 255;
    }
  }
  return data;
}

// -- CRC32, needed to append a PNG tEXt chunk ------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Splice a tEXt chunk in before IEND so the owner is readable via exiftool. */
function addPngText(png, keyword, text) {
  const iendAt = png.length - 12; // IEND is always the final 12 bytes
  const payload = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ]);
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'latin1'), payload]);

  const chunk = Buffer.alloc(typeAndData.length + 8);
  chunk.writeUInt32BE(payload.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), chunk.length - 4);

  return Buffer.concat([png.subarray(0, iendAt), chunk, png.subarray(iendAt)]);
}

function makePng(file, owner) {
  const width = 480;
  const height = 320;
  const png = new PNG({ width, height });
  drawBands(width, height, ownerColour(owner), 8).copy(png.data);

  const encoded = PNG.sync.write(png);
  return addPngText(
    encoded,
    'Description',
    `${owner.profile.fullName} <${owner.email}> | ${file.id} | ${file.fileName} | ${TASK}`
  );
}

/** Insert a JPEG COM (comment) segment straight after SOI. Valid per JFIF. */
function addJpegComment(jpg, text) {
  const bytes = Buffer.from(text, 'latin1');
  const seg = Buffer.alloc(bytes.length + 4);
  seg.writeUInt16BE(0xfffe, 0);              // COM marker
  seg.writeUInt16BE(bytes.length + 2, 2);    // length includes these 2 bytes
  bytes.copy(seg, 4);
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]);
}

function makeJpeg(file, owner) {
  const width = 480;
  const height = 320;
  const raw = drawBands(width, height, ownerColour(owner), 6);
  const encoded = jpeg.encode({ data: raw, width, height }, 88);

  return addJpegComment(
    Buffer.from(encoded.data),
    `${owner.profile.fullName} <${owner.email}> | ${file.id} | ${file.fileName} | ${TASK}`
  );
}

// ---------------------------------------------------------------- docx ----
function xmlEscape(s) {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]
  );
}

async function makeDocx(file, owner) {
  const paragraphs = describe(file, owner)
    .map((line) =>
      line === ''
        ? '<w:p/>'
        : `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
    )
    .join('');

  const zip = new JSZip();

  // Minimal but complete OOXML package — the three parts Word requires.
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  zip.folder('word').file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}<w:sectPr/></w:body>
</w:document>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ------------------------------------------------------------- dispatch ----
/**
 * Build the bytes for one seeded file. Returns a Buffer — never a string, so
 * nothing can be mangled by an implicit utf8 round-trip. [ADR-0013]
 */
export async function generateSampleFile(file, owner) {
  const ext = file.fileName.split('.').pop()?.toLowerCase();

  if (file.mimeType === 'application/pdf' || ext === 'pdf') return makePdf(file, owner);
  if (file.mimeType === 'image/png' || ext === 'png') return makePng(file, owner);
  if (file.mimeType === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return makeJpeg(file, owner);
  if (ext === 'docx') return makeDocx(file, owner);
  if (file.mimeType.startsWith('text/') || ext === 'txt' || ext === 'csv') {
    return makeText(file, owner);
  }

  // Unknown type: a readable text file beats a corrupt one pretending to be
  // something it is not. Loud, so a new seed entry does not silently degrade.
  console.warn(
    `[seed] no generator for ${file.mimeType} (${file.fileName}) — writing plain text`
  );
  return makeText(file, owner);
}
