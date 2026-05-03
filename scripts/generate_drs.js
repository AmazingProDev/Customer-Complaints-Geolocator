
import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import * as XLSX from 'xlsx';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, '../public/data');
const OUT_FILE = path.join(PUBLIC_DIR, 'drs.json');

async function generateDRs() {
    console.log('Starting DR generation...');

    try {
        // 1. Load Data
        const provincesRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'provinces.json'));
        const provinces = JSON.parse(provincesRaw);

        const communesRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'communes.json'));
        const communes = JSON.parse(communesRaw);

        const drMappingPath = path.join(PUBLIC_DIR, 'province_to_dr.xlsx');
        const drBuffer = fs.readFileSync(drMappingPath);
        const drWb = XLSX.read(drBuffer, { type: 'buffer' });
        const drSheet = drWb.Sheets[drWb.SheetNames[0]];
        const drRows = XLSX.utils.sheet_to_json(drSheet);

        // 2. Build Mapping
        const drMap = new Map();
        drRows.forEach(row => {
            const drName = row['DR'];
            const provinceName = row['Province'];
            if (drName && provinceName) {
                if (!drMap.has(drName)) drMap.set(drName, []);
                drMap.get(drName).push(provinceName);
            }
        });

        // 3. Exception Logic (Same as main.js)
        const normalize = (str) => String(str).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const exceptions = {
            sourceProvince: 'benslimane',
            targetDR: 'DRR',
            communes: ['el mansouria', 'bouznika', 'charrate']
        };

        const drFeatures = [];
        const allDRs = new Set(drMap.keys());
        allDRs.add(exceptions.targetDR);

        console.log(`Processing ${allDRs.size} DRs...`);

        for (const drName of allDRs) {
            const provNames = drMap.get(drName) || [];
            let featuresToUnion = [];

            for (const provName of provNames) {
                const normProvName = normalize(provName);

                if (normProvName === normalize(exceptions.sourceProvince)) {
                    // Benslimane Exception
                    const provinceFeat = provinces.features.find(f => {
                        const props = f.properties;
                        const pName = props.Nom_Provin || props.Nom_provin || props.NAME;
                        return normalize(pName) === normProvName;
                    });

                    if (provinceFeat) {
                        const pCode = provinceFeat.properties.Code_Provi;
                        const provCommunes = communes.features.filter(c => c.properties.Code_Provi === pCode);

                        provCommunes.forEach(c => {
                            const props = c.properties;
                            const cName = props.Nom_Commun || props.Nom_commun || props.NAME;
                            if (!exceptions.communes.includes(normalize(cName))) {
                                featuresToUnion.push(c);
                            }
                        });
                    }
                } else {
                    // Normal Province
                    const provFeatures = provinces.features.filter(f => {
                        const props = f.properties;
                        const pName = props.Nom_Provin || props.Nom_provin || props.NAME;
                        return normalize(provName) === normalize(pName);
                    });
                    featuresToUnion.push(...provFeatures);
                }
            }

            // Target DR Exception Additions
            if (drName === exceptions.targetDR) {
                const provinceFeat = provinces.features.find(f => {
                    const props = f.properties;
                    const pName = props.Nom_Provin || props.Nom_provin || props.NAME;
                    return normalize(pName) === normalize(exceptions.sourceProvince);
                });

                if (provinceFeat) {
                    const pCode = provinceFeat.properties.Code_Provi;
                    const provCommunes = communes.features.filter(c => c.properties.Code_Provi === pCode);

                    provCommunes.forEach(c => {
                        const props = c.properties;
                        const cName = props.Nom_Commun || props.Nom_commun || props.NAME;
                        if (exceptions.communes.includes(normalize(cName))) {
                            featuresToUnion.push(c);
                        }
                    });
                }
            }

            // Union
            if (featuresToUnion.length > 0) {
                try {
                    let unioned = featuresToUnion[0];
                    for (let i = 1; i < featuresToUnion.length; i++) {
                        unioned = turf.union(unioned, featuresToUnion[i]);
                    }
                    if (unioned) {
                        unioned.properties = { NAME: drName, Type: 'DR' };
                        drFeatures.push(unioned);
                    }
                } catch (e) {
                    console.error(`Error unioning ${drName}:`, e.message);
                }
            }
        }

        // 4. Save
        const fc = { type: "FeatureCollection", features: drFeatures };
        fs.writeFileSync(OUT_FILE, JSON.stringify(fc));
        console.log(`Success! Wrote ${drFeatures.length} DRs to ${OUT_FILE}`);

    } catch (err) {
        console.error("Generation failed:", err);
        process.exit(1);
    }
}

generateDRs();
