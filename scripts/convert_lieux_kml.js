import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import util from 'util';

const execFilePromise = util.promisify(execFile);

const DEFAULT_INPUT = '/Users/abdelilah/Downloads/0/lieux.kml';
const DEFAULT_OUTPUT = './public/data/lieux_places.json';
const OGR2OGR = '/opt/homebrew/bin/ogr2ogr';
const ALLOWED_FCLASSES = new Set([
  'city',
  'national_capital',
  'town',
  'village',
  'hamlet',
  'suburb',
  'locality',
  'island'
]);

function parseArgs(argv) {
  const result = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      result.input = argv[i + 1];
      i += 1;
    } else if (arg === '--output' && argv[i + 1]) {
      result.output = argv[i + 1];
      i += 1;
    }
  }

  return result;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function pickProperty(properties, keys) {
  if (!properties) return '';
  for (const key of keys) {
    const value = properties[key];
    if (value != null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

async function convertLieuxKml(inputPath, outputPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lieux-kml-'));
  const tmpGeoJsonPath = path.join(tmpDir, 'lieux.geojson');

  try {
    await execFilePromise(OGR2OGR, ['-f', 'GeoJSON', tmpGeoJsonPath, inputPath]);
    const raw = await fs.readFile(tmpGeoJsonPath, 'utf8');
    const geojson = JSON.parse(raw);
    const places = [];

    for (const feature of geojson.features || []) {
      if (feature?.geometry?.type !== 'Point') continue;

      const [lng, lat] = feature.geometry.coordinates || [];
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

      const properties = feature.properties || {};
      const name = normalizeText(pickProperty(properties, ['name', 'Name']));
      const fclass = normalizeText(pickProperty(properties, ['fclass', 'Fclass'])).toLowerCase();
      if (!name || !ALLOWED_FCLASSES.has(fclass)) continue;

      const populationRaw = pickProperty(properties, ['population', 'Population']);
      const population = Number.isFinite(Number(populationRaw)) ? Number(populationRaw) : 0;
      const osmId = normalizeText(pickProperty(properties, ['osm_id', 'Osm_id']));

      places.push({
        name,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        fclass,
        population,
        osmId
      });
    }

    places.sort((a, b) => {
      if (b.population !== a.population) return b.population - a.population;
      if (a.fclass !== b.fclass) return a.fclass.localeCompare(b.fclass);
      return a.name.localeCompare(b.name);
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      source: inputPath,
      count: places.length,
      places
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload));
    console.log(`Saved ${places.length} places to ${outputPath}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const { input, output } = parseArgs(process.argv.slice(2));
convertLieuxKml(path.resolve(input), path.resolve(output)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
