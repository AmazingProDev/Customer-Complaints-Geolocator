const COORDINATE_PART_PATTERN = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';
const COORDINATE_SEARCH_PATTERN = new RegExp(
    `^\\s*(${COORDINATE_PART_PATTERN})(?:\\s*,\\s*|\\s+)(${COORDINATE_PART_PATTERN})\\s*$`
);

function isLatitudeInRange(value) {
    return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLongitudeInRange(value) {
    return Number.isFinite(value) && value >= -180 && value <= 180;
}

function formatCoordinateNumber(value) {
    return Number(value).toFixed(6);
}

export function parseCoordinateSearchQuery(queryText) {
    const match = String(queryText || '').match(COORDINATE_SEARCH_PATTERN);
    if (!match) {
        return null;
    }

    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (!isLatitudeInRange(lat) || !isLongitudeInRange(lng)) {
        return null;
    }

    return { lat, lng };
}

export function createCoordinateSearchResult(queryText) {
    const coordinates = parseCoordinateSearchQuery(queryText);
    if (!coordinates) {
        return null;
    }

    const label = `${formatCoordinateNumber(coordinates.lat)}, ${formatCoordinateNumber(coordinates.lng)}`;
    return {
        category: 'coordinates',
        name: `Coordinates (${label})`,
        sourceLabel: 'Coordinates',
        metaLabel: `Coordinates • ${label}`,
        lat: coordinates.lat,
        lng: coordinates.lng
    };
}
