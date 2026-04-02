// ── SHP / DBF / PRJ writer ───────────────────────────────────────────────────
// Pure JS — no ArcGIS dependency. Exposed as globals for use in main.js.

function writeInt32BE(buf, val, offset) {
  buf[offset]     = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>>  8) & 0xff;
  buf[offset + 3] =  val         & 0xff;
}

function writeInt32LE(buf, val, offset) {
  buf[offset]     =  val         & 0xff;
  buf[offset + 1] = (val >>>  8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function writeDoubleLEInto(buf, val, offset) {
  const tmp = new Float64Array([val]);
  const bytes = new Uint8Array(tmp.buffer);
  for (let i = 0; i < 8; i++) buf[offset + i] = bytes[i];
}

// Returns {shp, shx} as Uint8Array
function buildSHP(features) {
  const geomType = features.length ? features[0].geometry.type : "point";
  let shpType;
  if (geomType === "point" || geomType === "multipoint") shpType = 1;
  else if (geomType === "polyline") shpType = 3;
  else shpType = 5; // polygon

  const records = features.map((f, idx) => {
    const geom = f.geometry;
    let content;
    if (shpType === 1) {
      content = new Uint8Array(20);
      writeInt32LE(content, 1, 0);
      writeDoubleLEInto(content, geom.longitude ?? geom.x, 4);
      writeDoubleLEInto(content, geom.latitude  ?? geom.y, 12);
    } else if (shpType === 3 || shpType === 5) {
      const paths = shpType === 3 ? (geom.paths || []) : (geom.rings || []);
      const numParts  = paths.length;
      const numPoints = paths.reduce((s, p) => s + p.length, 0);
      const byteLen = 4 + 32 + 4 + 4 + 4 * numParts + 16 * numPoints;
      content = new Uint8Array(byteLen);
      writeInt32LE(content, shpType, 0);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      paths.forEach(p => p.forEach(([x, y]) => {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }));
      writeDoubleLEInto(content, minX, 4);
      writeDoubleLEInto(content, minY, 12);
      writeDoubleLEInto(content, maxX, 20);
      writeDoubleLEInto(content, maxY, 28);
      writeInt32LE(content, numParts,  36);
      writeInt32LE(content, numPoints, 40);
      let off = 44;
      let ptIdx = 0;
      paths.forEach(p => {
        writeInt32LE(content, ptIdx, off); off += 4;
        ptIdx += p.length;
      });
      paths.forEach(p => p.forEach(([x, y]) => {
        writeDoubleLEInto(content, x, off); off += 8;
        writeDoubleLEInto(content, y, off); off += 8;
      }));
    }
    return { recNum: idx + 1, content };
  });

  const headerWords = 50;
  let dataBytes = 0;
  records.forEach(r => { dataBytes += 8 + r.content.length; });
  const totalWords = headerWords + dataBytes / 2;

  const shp = new Uint8Array(100 + dataBytes);
  writeInt32BE(shp, 9994, 0);
  writeInt32BE(shp, totalWords, 24);
  writeInt32LE(shp, 1000, 28);
  writeInt32LE(shp, shpType, 32);

  if (features.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (shpType === 1) {
      features.forEach(f => {
        const x = f.geometry.longitude ?? f.geometry.x;
        const y = f.geometry.latitude  ?? f.geometry.y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      });
    } else {
      features.forEach(f => {
        const paths = shpType === 3 ? (f.geometry.paths || []) : (f.geometry.rings || []);
        paths.forEach(p => p.forEach(([x, y]) => {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }));
      });
    }
    writeDoubleLEInto(shp, minX, 36);
    writeDoubleLEInto(shp, minY, 44);
    writeDoubleLEInto(shp, maxX, 52);
    writeDoubleLEInto(shp, maxY, 60);
  }

  const shx = new Uint8Array(100 + records.length * 8);
  writeInt32BE(shx, 9994, 0);
  writeInt32BE(shx, 50 + records.length * 4, 24);
  writeInt32LE(shx, 1000, 28);
  writeInt32LE(shx, shpType, 32);

  let shpOff = 100;
  records.forEach((r, i) => {
    writeInt32BE(shp, r.recNum, shpOff);
    writeInt32BE(shp, r.content.length / 2, shpOff + 4);
    shp.set(r.content, shpOff + 8);
    const offsetWords  = shpOff / 2;
    const contentWords = r.content.length / 2;
    writeInt32BE(shx, offsetWords,  100 + i * 8);
    writeInt32BE(shx, contentWords, 100 + i * 8 + 4);
    shpOff += 8 + r.content.length;
  });

  return { shp, shx };
}

function buildDBF(features) {
  if (!features.length) return new Uint8Array(32 + 1);
  const attrs = features[0].attributes || {};
  const fields = Object.keys(attrs).filter(k => k !== null && k !== undefined);

  const fieldDefs = fields.map(name => ({
    name: name.substring(0, 10),
    type: "C",
    length: 254
  }));

  const headerSize = 32 + fieldDefs.length * 32 + 1;
  const recordSize = 1 + fieldDefs.reduce((s, f) => s + f.length, 0);
  const totalSize  = headerSize + features.length * recordSize + 1;
  const buf = new Uint8Array(totalSize);

  buf[0] = 3;
  const now = new Date();
  buf[1] = now.getFullYear() - 1900;
  buf[2] = now.getMonth() + 1;
  buf[3] = now.getDate();
  writeInt32LE(buf, features.length, 4);
  buf[8]  = headerSize & 0xff;
  buf[9]  = (headerSize >> 8) & 0xff;
  buf[10] = recordSize & 0xff;
  buf[11] = (recordSize >> 8) & 0xff;

  const enc = new TextEncoder();
  fieldDefs.forEach((f, i) => {
    const off = 32 + i * 32;
    const nameBytes = enc.encode(f.name);
    buf.set(nameBytes.slice(0, 10), off);
    buf[off + 11] = f.type.charCodeAt(0);
    buf[off + 16] = f.length;
  });
  buf[32 + fieldDefs.length * 32] = 0x0d;

  let off = headerSize;
  features.forEach(feat => {
    buf[off++] = 0x20;
    const a = feat.attributes || {};
    fieldDefs.forEach((f, fi) => {
      const val = a[fields[fi]];
      const str = val === null || val === undefined ? "" : String(val);
      const bytes = enc.encode(str.substring(0, f.length));
      buf.set(bytes, off);
      off += f.length;
    });
  });
  buf[off] = 0x1a;

  return buf;
}

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",' +
  'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],' +
  'UNIT["Degree",0.0174532925199433]]';
