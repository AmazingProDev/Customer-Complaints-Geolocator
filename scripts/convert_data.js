import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';

const execPromise = util.promisify(exec);

const INPUT_DIR = './Tables Régions_Provinces et communes';
const OUTPUT_DIR = './public/data';

const FILES_TO_CONVERT = [
  { name: 'regions', file: 'DA_REGIONS_12R.TAB' },
  { name: 'provinces', file: 'DA_PROVINCES_12R.TAB' },
  { name: 'communes', file: 'DA_COMMUNES_12R.TAB' }
];

async function convert() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const { name, file } of FILES_TO_CONVERT) {
    const inputPath = path.join(INPUT_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, `${name}.json`);

    console.log(`Converting ${file} to ${name}.json...`);

    // Command: ogr2ogr -f GeoJSON -t_srs EPSG:4326 [output] [input]
    // Added -lco COORDINATE_PRECISION=6 to reduce file size slightly if needed, but standard is fine.
    const command = `ogr2ogr -f GeoJSON -t_srs EPSG:4326 "${outputPath}" "${inputPath}"`;

    try {
      const { stdout, stderr } = await execPromise(command);
      if (stderr) console.error(`Warning/Error for ${name}:`, stderr);
      console.log(`Successfully converted ${name}`);
    } catch (error) {
      console.error(`Failed to convert ${name}:`, error.message);
    }
  }
}

convert().catch(console.error);
