import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

function resizeNearest(srcPng, outW, outH) {
  const dst = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    const sy = Math.floor((y / outH) * srcPng.height);
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor((x / outW) * srcPng.width);
      const si = (srcPng.width * sy + sx) << 2;
      const di = (outW * y + x) << 2;
      dst.data[di + 0] = srcPng.data[si + 0];
      dst.data[di + 1] = srcPng.data[si + 1];
      dst.data[di + 2] = srcPng.data[si + 2];
      dst.data[di + 3] = srcPng.data[si + 3];
    }
  }
  return dst;
}

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error('Usage: node make-favicons.mjs <src.png>');

  const srcPath = path.resolve(src);
  const buf = fs.readFileSync(srcPath);
  const png = PNG.sync.read(buf);

  const outDir = path.resolve(process.argv[3] || path.join(path.dirname(srcPath), '..'));
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [16, 32, 48, 64, 128, 256];
  for (const s of sizes) {
    const out = resizeNearest(png, s, s);
    const outPath = path.join(outDir, `favicon-${s}.png`);
    fs.writeFileSync(outPath, PNG.sync.write(out));
    console.log('Wrote', outPath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
