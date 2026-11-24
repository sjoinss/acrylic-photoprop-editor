// node build.cjs → index.html (단일 파일)
const fs = require('fs'), p = require('path');
const r = (f) => fs.readFileSync(p.join(__dirname, 'src', f), 'utf8');
const map = { STYLE: 'style.css', CORE: 'core.js', WORKER: 'worker.js', APP: 'app.js' };
let html = r('shell.html');
for (const [k, f] of Object.entries(map)) {
  const s = r(f);
  if (/<\/script/i.test(s)) throw new Error(f + ': </script 포함');
  html = html.replace(`/*${k}*/`, () => s);
}
fs.writeFileSync(p.join(__dirname, 'index.html'), html);
console.log('index.html', (html.length / 1024).toFixed(0) + 'KB');
