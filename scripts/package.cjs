// Đóng gói thành thư mục chạy được trên Windows: dist/VokaraStudio-win32-x64/VokaraStudio.exe

const path = require('node:path');

(async () => {
  const module = await import('@electron/packager');
  const packager = module.packager || module.default;
  const root = path.join(__dirname, '..');
  const paths = await packager({
    dir: root,
    name: 'VokaraStudio',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: true,
    icon: path.join(root, 'build', 'icon.ico'),
    ignore: [/^\/test($|\/)/, /^\/scripts($|\/)/, /^\/dist($|\/)/, /^\/\.gitignore$/, /^\/README\.md$/],
    win32metadata: {
      ProductName: 'Vokara Studio',
      FileDescription: 'Vokara Studio',
      CompanyName: 'Vokara Studio',
    },
  });
  console.log('Đã đóng gói:', paths.join(', '));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
