import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const DEFAULT_INPUT = '/Users/abdelilah/Documents/My projects/Sites and Data/Sites/BDD_Mensuel_M04.xlsx';
const DEFAULT_OUTPUT = path.resolve('public/data/site_bdd_builtin.json');

const SITE_BDD_CONFIG = {
    '2G': {
        siteField: 'BTSName',
        sectorField: 'CELLNAME'
    },
    '3G': {
        siteField: 'NODEBName',
        sectorField: 'CELLNAME'
    },
    '4G': {
        siteField: 'BaseStationName',
        sectorField: 'CellName'
    }
};

function roundTo(value, decimals = 6) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function createPayloadFromWorkbook(workbook, fileName) {
    const payload = {
        fileName,
        generatedAt: new Date().toISOString(),
        datasets: {}
    };

    Object.entries(SITE_BDD_CONFIG).forEach(([tech, config]) => {
        const sheet = workbook.Sheets[tech];
        const dataset = {
            sites: [],
            sectors: []
        };

        if (!sheet) {
            payload.datasets[tech] = dataset;
            return;
        }

        const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
        const siteMap = new Map();
        const sectors = [];

        rows.forEach((row, index) => {
            const lat = Number(row.Latitude);
            const lng = Number(row.Longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return;
            }

            const siteName = String(row[config.siteField] || row[config.sectorField] || `${tech} Site ${index + 1}`).trim();
            const sectorName = String(row[config.sectorField] || siteName).trim();
            const azimuth = Number(row.Azimut);
            const siteKey = `${siteName}|${roundTo(lat)}|${roundTo(lng)}`;

            if (!siteMap.has(siteKey)) {
                siteMap.set(siteKey, {
                    siteName,
                    lat,
                    lng,
                    sectorCount: 0
                });
            }

            siteMap.get(siteKey).sectorCount += 1;
            sectors.push({
                id: `${tech}-${index + 1}`,
                tech,
                siteName,
                sectorName,
                lat,
                lng,
                azimuth
            });
        });

        dataset.sites = [...siteMap.values()];
        dataset.sectors = sectors;
        payload.datasets[tech] = dataset;
    });

    return payload;
}

function main() {
    const input = path.resolve(process.argv[2] || DEFAULT_INPUT);
    const output = path.resolve(process.argv[3] || DEFAULT_OUTPUT);

    if (!fs.existsSync(input)) {
        throw new Error(`Workbook not found: ${input}`);
    }

    const workbook = XLSX.readFile(input, { cellDates: false });
    const payload = createPayloadFromWorkbook(workbook, path.basename(input));

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(payload));

    const summary = Object.entries(payload.datasets)
        .map(([tech, dataset]) => `${tech}: ${dataset.sites.length} sites / ${dataset.sectors.length} sectors`)
        .join(' | ');

    console.log(`Wrote ${output}`);
    console.log(summary);
}

main();
