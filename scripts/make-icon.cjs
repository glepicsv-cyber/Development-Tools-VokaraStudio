// Cắt logo từ build/icon-source.webp thành build/icon.ico và src/assets/logo.png.
// Dùng canvas của Electron nên không cần công cụ ngoài. Chạy: npx electron scripts/make-icon.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'build', 'icon-source.webp');
// Khung logo trong hình gốc 1024×1024, tính theo tỉ lệ để không phụ thuộc kích thước.
const CROP = { x: 0.118, y: 0.113, size: 0.772 };
const CORNER = 0.145;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const RENDER = `async (dataUrl, crop, corner, sizes) => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const out = {};
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.beginPath();
    g.roundRect(0, 0, size, size, size * corner);
    g.clip();
    g.drawImage(image, crop.x * image.naturalWidth, crop.y * image.naturalHeight, crop.size * image.naturalWidth, crop.size * image.naturalWidth, 0, 0, size, size);
    out[size] = { png: canvas.toDataURL('image/png').split(',')[1], rgba: Array.from(g.getImageData(0, 0, size, size).data) };
  }
  return out;
}`;

/** BMP 32-bit trong ICO để cả các phiên bản Explorer cũ đọc được cỡ nhỏ. */
function bmpEntry(size, rgba) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length, 20);
  return Buffer.concat([header, pixels, Buffer.alloc(Math.ceil(size / 32) * 4 * size)]);
}

function buildIco(rendered) {
  const images = ICO_SIZES.map((size) => (size === 256 ? Buffer.from(rendered[size].png, 'base64') : bmpEntry(size, rendered[size].rgba)));
  const directory = Buffer.alloc(6 + ICO_SIZES.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(ICO_SIZES.length, 4);
  let offset = directory.length;
  ICO_SIZES.forEach((size, index) => {
    const at = 6 + index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at);
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(images[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  return Buffer.concat([directory, ...images]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
  const dataUrl = `data:image/webp;base64,${fs.readFileSync(SOURCE).toString('base64')}`;
  const sizes = [...ICO_SIZES, 96];
  const rendered = await win.webContents.executeJavaScript(`(${RENDER})(${JSON.stringify(dataUrl)}, ${JSON.stringify(CROP)}, ${CORNER}, ${JSON.stringify(sizes)})`);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(rendered));
  fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'logo.png'), Buffer.from(rendered[96].png, 'base64'));
  console.log('Đã tạo icon');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
