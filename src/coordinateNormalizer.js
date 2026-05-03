import * as XLSX from 'xlsx';
import proj4 from 'proj4';

const MOROCCO_LON_MIN = -17.5;
const MOROCCO_LON_MAX = -0.5;
const MOROCCO_LAT_MIN = 20.0;
const MOROCCO_LAT_MAX = 36.5;
const ANRT_DATA_START_ROW = 8;
const ANRT_SOURCE_X_INDEX = 5;
const ANRT_SOURCE_Y_INDEX = 6;
const WGS84 = 'WGS84';
const EPSG_26191 = 'EPSG:26191';

proj4.defs(
    EPSG_26191,
    '+proj=lcc +lat_1=33.3 +lat_0=33.3 +lon_0=-5.4 +k_0=0.999625769 +x_0=500000 +y_0=300000 +ellps=clrk80ign +towgs84=31,146,47,0,0,0,0 +units=m +no_defs +type=crs'
);

function normalizeText(value) {
    if (value == null) return '';
    return String(value).replace(/\u00a0/g, ' ').trim();
}

function normalizeHeader(value) {
    return normalizeText(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isBlank(value) {
    return normalizeText(value) === '';
}

function roundTo(value, decimals) {
    return Number(value.toFixed(decimals));
}

function parseNumericValue(value) {
    if (value == null || typeof value === 'boolean') return null;

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    const text = normalizeText(value);
    if (!text) return null;

    const compact = text.replace(/\s+/g, '').replace(',', '.');
    if (/^[+-]?\d+(?:\.\d+)?$/.test(compact)) {
        return Number(compact);
    }

    return null;
}

function inMoroccoBBox(lon, lat) {
    return (
        lon >= MOROCCO_LON_MIN &&
        lon <= MOROCCO_LON_MAX &&
        lat >= MOROCCO_LAT_MIN &&
        lat <= MOROCCO_LAT_MAX
    );
}

function looksLikeDms(value) {
    const text = normalizeText(value);
    return text ? ['°', '\'', '"'].some((marker) => text.includes(marker)) : false;
}

function cleanupDmsComponent(component) {
    return component
        .trim()
        .replace(',', '.')
        .replace(/S/g, '5')
        .replace(/s/g, '5')
        .replace(/O/g, '0')
        .replace(/o/g, '0');
}

function parseDmsValue(value, axis) {
    const text = normalizeText(value);
    if (!text) {
        return { value: null, reason: 'empty_dms' };
    }

    let raw = text.replace(/\s+/g, '');
    let direction = null;

    while (raw && ['"', '\''].includes(raw.at(-1))) {
        raw = raw.slice(0, -1);
    }

    if (raw) {
        const tail = raw.at(-1).toUpperCase();
        if (['N', 'S', 'E', 'W', 'O', '0'].includes(tail)) {
            direction = tail === '0' ? 'O' : tail;
            raw = raw.slice(0, -1);

            while (raw && ['"', '\''].includes(raw.at(-1))) {
                raw = raw.slice(0, -1);
            }
        }
    }

    const normalized = raw.replace(/°/g, '\'').replace(/"/g, '\'');
    const parts = normalized.split('\'').filter(Boolean);

    if (
        parts.length === 4 &&
        parts.at(-1).length === 1 &&
        ['N', 'S', 'E', 'W', 'O', '0'].includes(parts.at(-1).toUpperCase())
    ) {
        direction = parts.at(-1).toUpperCase() === '0' ? 'O' : parts.at(-1).toUpperCase();
        parts.pop();
    }

    if (parts.length !== 3) {
        return { value: null, reason: 'invalid_dms_token_count' };
    }

    const [degText, minText, secText] = parts.map(cleanupDmsComponent);

    if (!/^[+-]?\d+(?:\.\d+)?$/.test(degText)) {
        return { value: null, reason: 'invalid_dms_degrees' };
    }
    if (!/^\d+(?:\.\d+)?$/.test(minText)) {
        return { value: null, reason: 'invalid_dms_minutes' };
    }
    if (!/^\d+(?:\.\d+)?$/.test(secText)) {
        return { value: null, reason: 'invalid_dms_seconds' };
    }

    const degrees = Number(degText);
    const minutes = Number(minText);
    const seconds = Number(secText);

    if (minutes >= 60 || seconds >= 60) {
        return { value: null, reason: 'invalid_dms_range' };
    }

    if (!direction) {
        direction = axis === 'lon' ? 'O' : 'N';
    }

    const absolute = Math.abs(degrees) + minutes / 60 + seconds / 3600;
    const sign = ['W', 'O', 'S'].includes(direction.toUpperCase()) ? -1 : 1;

    return { value: roundTo(sign * absolute, 9), reason: 'parsed_dms' };
}

function classifyCoordinateType(rawX, rawY, parsedX, parsedY) {
    if (isBlank(rawX) && isBlank(rawY)) return 'blank';
    if (looksLikeDms(rawX) || looksLikeDms(rawY)) return 'sexagesimal_or_text';
    if (parsedX == null || parsedY == null) return 'sexagesimal_or_text';
    if (Math.abs(parsedX) > 1000 || Math.abs(parsedY) > 1000) return 'projected_zone_i';
    return 'decimal';
}

function baseResult(overrides) {
    return {
        rowNumber: null,
        code: null,
        sourceCoordType: 'decimal',
        normalizedLongitude: null,
        normalizedLatitude: null,
        normalizationAction: 'unknown',
        normalizationConfidence: 0,
        needsReview: false,
        reviewReason: '',
        ...overrides
    };
}

function decimalCandidates(value, rawValue) {
    const candidates = [];
    const text = normalizeText(rawValue);
    const textHasDecimal = text.includes('.') || text.includes(',');

    if (text && !textHasDecimal && Math.abs(value) >= 100) {
        for (let shift = 1; shift <= 3; shift += 1) {
            const shifted = value / (10 ** shift);
            if (Math.abs(shifted) < 100) {
                candidates.push(shifted);
            }
        }
    }

    const deduped = [];
    const seen = new Set();
    candidates.forEach((candidate) => {
        const rounded = roundTo(candidate, 9);
        if (!seen.has(rounded)) {
            seen.add(rounded);
            deduped.push(candidate);
        }
    });
    return deduped;
}

function tryDecimalPointRepair(x, y, rawX, rawY) {
    const candidates = [];

    decimalCandidates(x, rawX).forEach((repairedX) => {
        if (repairedX >= 0 && repairedX <= 20 && y >= MOROCCO_LAT_MIN && y <= MOROCCO_LAT_MAX) {
            candidates.push({
                lon: -Math.abs(repairedX),
                lat: y,
                action: 'repaired_decimal_point_in_x_and_fixed_missing_minus'
            });
        }
    });

    decimalCandidates(y, rawY).forEach((repairedY) => {
        if (x >= 0 && x <= 20 && repairedY >= MOROCCO_LAT_MIN && repairedY <= MOROCCO_LAT_MAX) {
            candidates.push({
                lon: -Math.abs(x),
                lat: repairedY,
                action: 'repaired_decimal_point_in_y_and_fixed_missing_minus'
            });
        }
    });

    const uniqueCandidates = new Map();
    candidates.forEach(({ lon, lat, action }) => {
        if (inMoroccoBBox(lon, lat)) {
            uniqueCandidates.set(`${roundTo(lon, 7)}|${roundTo(lat, 7)}`, { lon, lat, action });
        }
    });

    if (uniqueCandidates.size !== 1) return null;

    const [{ lon, lat, action }] = [...uniqueCandidates.values()];
    return baseResult({
        normalizedLongitude: roundTo(lon, 7),
        normalizedLatitude: roundTo(lat, 7),
        normalizationAction: action,
        normalizationConfidence: 0.75
    });
}

function normalizeDecimalPair(x, y, rawX, rawY) {
    if (inMoroccoBBox(x, y)) {
        return baseResult({
            normalizedLongitude: roundTo(x, 7),
            normalizedLatitude: roundTo(y, 7),
            normalizationAction: 'accepted_decimal_as_is',
            normalizationConfidence: 1
        });
    }

    if (x >= 0 && x <= 20 && y >= MOROCCO_LAT_MIN && y <= MOROCCO_LAT_MAX) {
        return baseResult({
            normalizedLongitude: roundTo(-Math.abs(x), 7),
            normalizedLatitude: roundTo(y, 7),
            normalizationAction: 'fixed_missing_longitude_minus',
            normalizationConfidence: 0.98
        });
    }

    if (x >= MOROCCO_LAT_MIN && x <= MOROCCO_LAT_MAX && y >= MOROCCO_LON_MIN && y <= MOROCCO_LON_MAX) {
        return baseResult({
            normalizedLongitude: roundTo(y, 7),
            normalizedLatitude: roundTo(x, 7),
            normalizationAction: 'swapped_lat_lon_columns',
            normalizationConfidence: 0.97
        });
    }

    if (x >= MOROCCO_LAT_MIN && x <= MOROCCO_LAT_MAX && y >= 0 && y <= 20) {
        return baseResult({
            normalizedLongitude: roundTo(-Math.abs(y), 7),
            normalizedLatitude: roundTo(x, 7),
            normalizationAction: 'swapped_columns_and_fixed_missing_minus',
            normalizationConfidence: 0.95
        });
    }

    const repaired = tryDecimalPointRepair(x, y, rawX, rawY);
    if (repaired) return repaired;

    return baseResult({
        normalizationAction: 'flagged_decimal_outlier',
        normalizationConfidence: 0,
        needsReview: true,
        reviewReason: 'decimal_values_do_not_match_conservative_morocco_rules'
    });
}

function normalizeProjectedPair(parsedX, parsedY) {
    try {
        const [lon, lat] = proj4(EPSG_26191, WGS84, [parsedX, parsedY]);
        const roundedLon = roundTo(lon, 7);
        const roundedLat = roundTo(lat, 7);

        if (inMoroccoBBox(roundedLon, roundedLat)) {
            return baseResult({
                sourceCoordType: 'projected_zone_i',
                normalizedLongitude: roundedLon,
                normalizedLatitude: roundedLat,
                normalizationAction: 'converted_projected_zone_i',
                normalizationConfidence: 0.93
            });
        }

        return baseResult({
            sourceCoordType: 'projected_zone_i',
            normalizedLongitude: roundedLon,
            normalizedLatitude: roundedLat,
            normalizationAction: 'converted_projected_zone_i',
            normalizationConfidence: 0.4,
            needsReview: true,
            reviewReason: 'projected_result_outside_morocco_bbox'
        });
    } catch {
        return baseResult({
            sourceCoordType: 'projected_zone_i',
            normalizationAction: 'projected_conversion_failed',
            normalizationConfidence: 0,
            needsReview: true,
            reviewReason: 'projected_conversion_failed'
        });
    }
}

function normalizeRow(rowNumber, code, rawX, rawY) {
    const parsedX = parseNumericValue(rawX);
    const parsedY = parseNumericValue(rawY);
    const sourceCoordType = classifyCoordinateType(rawX, rawY, parsedX, parsedY);

    if (sourceCoordType === 'blank') {
        return baseResult({
            rowNumber,
            code,
            sourceCoordType: 'blank',
            normalizationAction: 'left_blank',
            normalizationConfidence: 1
        });
    }

    if (sourceCoordType === 'sexagesimal_or_text') {
        const dmsX = parseDmsValue(rawX, 'lon');
        const dmsY = parseDmsValue(rawY, 'lat');

        if (dmsX.value != null && dmsY.value != null) {
            const lon = roundTo(dmsX.value, 7);
            const lat = roundTo(dmsY.value, 7);
            const needsReview = !inMoroccoBBox(lon, lat);

            return baseResult({
                rowNumber,
                code,
                sourceCoordType,
                normalizedLongitude: lon,
                normalizedLatitude: lat,
                normalizationAction: 'parsed_dms_with_ocr_cleanup',
                normalizationConfidence: needsReview ? 0.45 : 0.85,
                needsReview,
                reviewReason: needsReview ? 'parsed_dms_result_outside_morocco_bbox' : ''
            });
        }

        if (parsedX != null && parsedY != null && (Math.abs(parsedX) > 1000 || Math.abs(parsedY) > 1000)) {
            const projectedResult = normalizeProjectedPair(parsedX, parsedY);
            projectedResult.rowNumber = rowNumber;
            projectedResult.code = code;
            return projectedResult;
        }

        if (parsedX != null && parsedY != null) {
            const decimalResult = normalizeDecimalPair(parsedX, parsedY, rawX, rawY);
            decimalResult.rowNumber = rowNumber;
            decimalResult.code = code;
            decimalResult.sourceCoordType = 'decimal';
            return decimalResult;
        }

        return baseResult({
            rowNumber,
            code,
            sourceCoordType,
            normalizationAction: 'flagged_unparsed_text_coordinates',
            normalizationConfidence: 0,
            needsReview: true,
            reviewReason: `could_not_parse_coordinates:${dmsX.reason}|${dmsY.reason}`
        });
    }

    if (sourceCoordType === 'projected_zone_i') {
        const projectedResult = normalizeProjectedPair(parsedX, parsedY);
        projectedResult.rowNumber = rowNumber;
        projectedResult.code = code;
        return projectedResult;
    }

    const decimalResult = normalizeDecimalPair(parsedX, parsedY, rawX, rawY);
    decimalResult.rowNumber = rowNumber;
    decimalResult.code = code;
    return decimalResult;
}

function isAnrtLocalitySheet(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
    const headerRow = rows[5] || [];
    const subHeaderRow = rows[6] || [];

    return (
        normalizeHeader(headerRow[0]) === 'code' &&
        normalizeHeader(subHeaderRow[5]).includes('longitude') &&
        normalizeHeader(subHeaderRow[6]).includes('latitude')
    );
}

function buildPointRecord({ id, displayName, lat, lng, original, normalization, sourceSheet, sourceRowNumber }) {
    return { id, displayName, lat, lng, original, normalization, sourceSheet, sourceRowNumber };
}

function parseAnrtWorkbook(sheet, sheetName) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
    const points = [];
    let totalRows = 0;
    let flaggedRows = 0;
    let skippedRows = 0;

    for (let rowIndex = ANRT_DATA_START_ROW - 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || [];
        if (!row.some((value) => !isBlank(value))) continue;

        totalRows += 1;

        const rowNumber = rowIndex + 1;
        const code = normalizeText(row[0]) || `row-${rowNumber}`;
        const locality = normalizeText(row[3]);
        const subLocality = normalizeText(row[4]);
        const displayName = locality || subLocality || code;
        const normalization = normalizeRow(rowNumber, code, row[ANRT_SOURCE_X_INDEX], row[ANRT_SOURCE_Y_INDEX]);

        if (normalization.needsReview) flaggedRows += 1;

        if (
            normalization.normalizedLongitude == null ||
            normalization.normalizedLatitude == null ||
            normalization.needsReview
        ) {
            skippedRows += 1;
            continue;
        }

        points.push(buildPointRecord({
            id: code,
            displayName,
            lat: normalization.normalizedLatitude,
            lng: normalization.normalizedLongitude,
            original: {
                Code: code,
                Province: row[1],
                Commune: row[2],
                Localite: locality,
                SousLocalite: subLocality,
                SourceX: row[ANRT_SOURCE_X_INDEX],
                SourceY: row[ANRT_SOURCE_Y_INDEX],
                DeclarationIAM: row[9],
                Perspective: row[10],
                TechnologiesEnvisagees: row[11],
                normalized_longitude: normalization.normalizedLongitude,
                normalized_latitude: normalization.normalizedLatitude,
                normalization_action: normalization.normalizationAction,
                normalization_confidence: normalization.normalizationConfidence
            },
            normalization,
            sourceSheet: sheetName,
            sourceRowNumber: rowNumber
        }));
    }

    return {
        points,
        summary: {
            sourceType: 'anrt_localities',
            sheetName,
            totalRows,
            plottedPoints: points.length,
            flaggedRows,
            skippedRows
        }
    };
}

function findPreferredKey(keys, predicates) {
    for (const predicate of predicates) {
        const key = keys.find((candidate) => predicate(normalizeHeader(candidate)));
        if (key) return key;
    }
    return null;
}

function parseGenericWorkbook(sheet, sheetName) {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

    if (rows.length === 0) {
        return {
            points: [],
            summary: { sourceType: 'generic', sheetName, totalRows: 0, plottedPoints: 0, flaggedRows: 0, skippedRows: 0 }
        };
    }

    const keys = Object.keys(rows[0]);
    const longitudeKey = findPreferredKey(keys, [
        (key) => key === 'normalized longitude' || key === 'normalized_longitude',
        (key) => key.includes('longitude') || key === 'lng' || key === 'long',
        (key) => key === 'x' || key.startsWith('x ')
    ]);
    const latitudeKey = findPreferredKey(keys, [
        (key) => key === 'normalized latitude' || key === 'normalized_latitude',
        (key) => key.includes('latitude') || key === 'lat',
        (key) => key === 'y' || key.startsWith('y ')
    ]);
    const nameKey = findPreferredKey(keys, [
        (key) => key.includes('site'),
        (key) => key.includes('localite') || key.includes('locality'),
        (key) => key.includes('name'),
        (key) => key.includes('code')
    ]);

    if (!longitudeKey || !latitudeKey) {
        throw new Error('Unable to find longitude/latitude columns in this workbook.');
    }

    const points = [];
    let flaggedRows = 0;
    let skippedRows = 0;

    rows.forEach((row, index) => {
        const normalization = normalizeRow(index + 2, row[nameKey] ?? null, row[longitudeKey], row[latitudeKey]);

        if (normalization.needsReview) flaggedRows += 1;

        if (
            normalization.normalizedLongitude == null ||
            normalization.normalizedLatitude == null ||
            normalization.needsReview
        ) {
            skippedRows += 1;
            return;
        }

        const fallbackId = nameKey ? normalizeText(row[nameKey]) : '';
        const id = fallbackId || `row-${index + 2}`;
        points.push(buildPointRecord({
            id,
            displayName: id,
            lat: normalization.normalizedLatitude,
            lng: normalization.normalizedLongitude,
            original: {
                ...row,
                normalized_longitude: normalization.normalizedLongitude,
                normalized_latitude: normalization.normalizedLatitude,
                normalization_action: normalization.normalizationAction,
                normalization_confidence: normalization.normalizationConfidence
            },
            normalization,
            sourceSheet: sheetName,
            sourceRowNumber: index + 2
        }));
    });

    return {
        points,
        summary: {
            sourceType: 'generic',
            sheetName,
            totalRows: rows.length,
            plottedPoints: points.length,
            flaggedRows,
            skippedRows
        }
    };
}

export function parseWorkbookPoints(workbook) {
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        throw new Error('Workbook does not contain any sheets.');
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
        throw new Error(`Unable to read worksheet "${sheetName}".`);
    }

    if (isAnrtLocalitySheet(sheet)) {
        return parseAnrtWorkbook(sheet, sheetName);
    }

    return parseGenericWorkbook(sheet, sheetName);
}
