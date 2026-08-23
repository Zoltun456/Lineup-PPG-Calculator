// Minimal, dependency-free .xlsx builder. Writes an uncompressed (STORED) ZIP
// containing the handful of OOXML parts Excel/Sheets/LibreOffice need for a
// simple multi-sheet workbook. No compression library required.

const textEncoder = new TextEncoder();

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  bytes(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  uint16(value) {
    return this.bytes(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  uint32(value) {
    return this.bytes(new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]));
  }

  toUint8Array() {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

function buildZip(files) {
  const localWriter = new ByteWriter();
  const centralWriter = new ByteWriter();
  const dosTime = 0;
  const dosDate = (1 << 9) | (1 << 5) | 1; // 2000-01-01, arbitrary but valid

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const contentBytes = textEncoder.encode(file.content);
    const crc = crc32(contentBytes);
    const localOffset = localWriter.length;

    localWriter
      .uint32(0x04034b50)
      .uint16(20)
      .uint16(0)
      .uint16(0)
      .uint16(dosTime)
      .uint16(dosDate)
      .uint32(crc)
      .uint32(contentBytes.length)
      .uint32(contentBytes.length)
      .uint16(nameBytes.length)
      .uint16(0)
      .bytes(nameBytes)
      .bytes(contentBytes);

    centralWriter
      .uint32(0x02014b50)
      .uint16(20)
      .uint16(20)
      .uint16(0)
      .uint16(0)
      .uint16(dosTime)
      .uint16(dosDate)
      .uint32(crc)
      .uint32(contentBytes.length)
      .uint32(contentBytes.length)
      .uint16(nameBytes.length)
      .uint16(0)
      .uint16(0)
      .uint16(0)
      .uint16(0)
      .uint32(0)
      .uint32(localOffset)
      .bytes(nameBytes);
  }

  const centralDirectoryOffset = localWriter.length;
  const centralDirectorySize = centralWriter.length;

  const endWriter = new ByteWriter();
  endWriter
    .uint32(0x06054b50)
    .uint16(0)
    .uint16(0)
    .uint16(files.length)
    .uint16(files.length)
    .uint32(centralDirectorySize)
    .uint32(centralDirectoryOffset)
    .uint16(0);

  const combined = new ByteWriter();
  combined.bytes(localWriter.toUint8Array());
  combined.bytes(centralWriter.toUint8Array());
  combined.bytes(endWriter.toUint8Array());
  return combined.toUint8Array();
}

function sheetXml(rows) {
  const rowsXml = rows.map((row, rowIndex) => {
    const cellsXml = row.map((value, columnIndex) => {
      const cellRef = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${cellRef}"><v>${value}</v></c>`;
      }
      return `<c r="${cellRef}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${rowsXml}</sheetData></worksheet>`;
}

const CONTENT_TYPES_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
  + `<Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
  + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
  + `</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`
  + `<borders count="1"><border/></borders>`
  + `<cellStyleXfs count="1"><xf/></cellStyleXfs>`
  + `<cellXfs count="1"><xf/></cellXfs>`
  + `</styleSheet>`;

/**
 * @param {{name: string, rows: Array<Array<string|number>>}[]} sheets
 * @returns {Blob}
 */
export function buildXlsxBlob(sheets) {
  if (!sheets.length) throw new Error("At least one sheet is required.");

  const contentTypes = [
    CONTENT_TYPES_HEADER,
    ...sheets.map((_, index) => (
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )),
    `</Types>`,
  ].join("");

  const workbookRels = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`,
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
    ...sheets.map((_, index) => (
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )),
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `</Relationships>`,
  ].join("");

  const workbookXml = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`,
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
    `<sheets>`,
    ...sheets.map((sheet, index) => (
      `<sheet name="${escapeXml(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )),
    `</sheets></workbook>`,
  ].join("");

  const files = [
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: ROOT_RELS },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
    { name: "xl/styles.xml", content: STYLES_XML },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(sheet.rows),
    })),
  ];

  const zipBytes = buildZip(files);
  return new Blob([zipBytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
