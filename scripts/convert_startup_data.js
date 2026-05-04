import fs from 'fs/promises';
import path from 'path';
import XLSX from 'xlsx';

const INPUTS = [
  {
    input: path.resolve('public/data/emergency_numbers.xlsx'),
    output: path.resolve('public/data/emergency_numbers.json')
  },
  {
    input: path.resolve('public/data/province_to_dr.xlsx'),
    output: path.resolve('public/data/province_to_dr.json')
  }
];

async function convertWorkbookToJson(inputPath, outputPath) {
  const workbook = XLSX.readFile(inputPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  await fs.writeFile(outputPath, JSON.stringify(rows, null, 2));
  console.log(`Wrote ${rows.length} rows to ${path.relative(process.cwd(), outputPath)}`);
}

async function main() {
  for (const { input, output } of INPUTS) {
    await convertWorkbookToJson(input, output);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
