import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import util from 'util';
import * as turf from '@turf/turf';

const execFilePromise = util.promisify(execFile);

const DEFAULT_INPUT = '/Users/abdelilah/Downloads/0/zones_habitees.kml';
const DEFAULT_OUTPUT = './public/data/zones_habitees_areas.json';
const OGR2OGR = '/opt/homebrew/bin/ogr2ogr';

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

function roundValue(value, decimals = 6) {
  return Number(Number(value).toFixed(decimals));
}

function roundCoordinates(value) {
  if (!Array.isArray(value)) return value;
  if (value.length > 0 && typeof value[0] === 'number') {
    return value.slice(0, 2).map((coord) => roundValue(coord));
  }
  return value.map((entry) => roundCoordinates(entry));
}

function createFallbackName(fclass, osmId, index) {
  const label = fclass || 'settlement';
  if (osmId) return `${label} ${osmId}`;
  return `Unnamed ${label} ${index + 1}`;
}

async function convertZonesHabiteesKml(inputPath, outputPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zones-habitees-kml-'));
  const tmpGeoJsonPath = path.join(tmpDir, 'zones_habitees.geojson');

  try {
    await execFilePromise(OGR2OGR, ['-f', 'GeoJSON', tmpGeoJsonPath, inputPath]);
    const raw = await fs.readFile(tmpGeoJsonPath, 'utf8');
    const geojson = JSON.parse(raw);
    const areas = [];

    for (const [index, feature] of (geojson.features || []).entries()) {
      const geometry = feature?.geometry;
      if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) continue;

      const properties = feature.properties || {};
      const fclass = normalizeText(pickProperty(properties, ['fclass', 'Fclass'])).toLowerCase();
      const osmId = normalizeText(pickProperty(properties, ['osm_id', 'Osm_id']));
      const rawName = normalizeText(pickProperty(properties, ['Name', 'name']));
      const name = rawName || createFallbackName(fclass, osmId, index);
      const populationRaw = pickProperty(properties, ['population', 'Population']);
      const population = Number.isFinite(Number(populationRaw)) ? Number(populationRaw) : 0;
      const bbox = turf.bbox(feature).map((value) => roundValue(value));
      const centroid = turf.centroid(feature).geometry.coordinates;

      areas.push({
        name,
        fclass,
        population,
        osmId,
        bbox,
        centroid: {
          lng: roundValue(centroid[0]),
          lat: roundValue(centroid[1])
        },
        geometry: {
          type: geometry.type,
          coordinates: roundCoordinates(geometry.coordinates)
        }
      });
    }

    areas.sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.fclass !== b.fclass) return a.fclass.localeCompare(b.fclass);
      return a.osmId.localeCompare(b.osmId);
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      source: inputPath,
      count: areas.length,
      areas
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload));
    console.log(`Saved ${areas.length} inhabited areas to ${outputPath}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const { input, output } = parseArgs(process.argv.slice(2));
convertZonesHabiteesKml(path.resolve(input), path.resolve(output)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
