// Generates the 100-page PDF used by the pdf.js benchmark. Run automatically
// before `dev` and `build`, or directly with `npm run spike:fixture`.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'fixtures');
const outFile = join(outDir, '100-pages.pdf');

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);

for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
  const page = pdf.addPage([612, 792]);

  page.drawText(`NookEdit PDF benchmark — page ${pageNumber}`, {
    x: 48,
    y: 744,
    size: 18,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });

  for (let line = 0; line < 28; line += 1) {
    page.drawText(`Line ${line + 1}: the quick brown fox jumps over the lazy dog.`, {
      x: 48,
      y: 704 - line * 22,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }
}

await mkdir(outDir, { recursive: true });
await writeFile(outFile, await pdf.save());
console.log(`Wrote ${outFile}`);
