function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function normalizeSearchText(value) {
    return normalizeName(value).replace(/\s+/g, ' ').trim();
}

function buildSearchVariants(value) {
    const normalized = normalizeSearchText(value);
    const variants = [];

    if (!normalized) {
        return variants;
    }

    variants.push(normalized);

    const relaxed = normalized
        .replace(/\+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (relaxed && !variants.includes(relaxed)) {
        variants.push(relaxed);
    }

    const compact = relaxed.replace(/\s+/g, '');
    if (compact && !variants.includes(compact)) {
        variants.push(compact);
    }

    return variants;
}

function roundTo(value, decimals = 6) {
    return Number(Number(value).toFixed(decimals));
}

function formatCoordinates(lat, lng) {
    return `${roundTo(lat, 6)}, ${roundTo(lng, 6)}`;
}

function hasExactSiteNameMatch(queryText, siteName) {
    const queryVariants = buildSearchVariants(queryText);
    const siteVariants = buildSearchVariants(siteName);

    if (!queryVariants.length || !siteVariants.length) {
        return false;
    }

    return queryVariants.some((queryVariant) => siteVariants.includes(queryVariant));
}

export function formatSiteNameMatchMeta(result) {
    return `${result.sourceLabel} • ${formatCoordinates(result.lat, result.lng)}`;
}

export function collectExactSiteNameMatches({
    queryText,
    processedPoints = [],
    siteBddState = {},
    siteBddConfig = {},
    techOrder = Object.keys(siteBddConfig)
} = {}) {
    if (!String(queryText || '').trim()) {
        return [];
    }

    const matches = [];
    const normalizedTechOrder = techOrder.length ? techOrder : Object.keys(siteBddConfig);

    normalizedTechOrder.forEach((tech, index) => {
        const dataset = siteBddState?.datasets?.[tech];
        const label = siteBddConfig?.[tech]?.label || `BDD ${tech}`;
        const sites = Array.isArray(dataset?.sites) ? dataset.sites : [];

        sites.forEach((site, siteIndex) => {
            if (!hasExactSiteNameMatch(queryText, site.siteName)) {
                return;
            }

            const result = {
                id: `site-bdd-${tech}-${siteIndex}`,
                category: 'site_bdd',
                name: site.siteName,
                sourceLabel: label,
                tech,
                lat: site.lat,
                lng: site.lng,
                sectorCount: site.sectorCount || 0,
                siteBddItem: site,
                sortOrder: index * 100000 + siteIndex
            };
            result.metaLabel = formatSiteNameMatchMeta(result);
            matches.push(result);
        });
    });

    processedPoints.forEach((point, index) => {
        const name = point.displayName || point.original?.['Site Name'] || point.id;
        if (!hasExactSiteNameMatch(queryText, name)) {
            return;
        }

        const result = {
            id: `site-imported-${point.id || index}`,
            category: 'site',
            name,
            sourceLabel: 'Imported workbook site',
            lat: point.lat,
            lng: point.lng,
            point,
            sortOrder: normalizedTechOrder.length * 100000 + index
        };
        result.metaLabel = formatSiteNameMatchMeta(result);
        matches.push(result);
    });

    return matches.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
            return a.sortOrder - b.sortOrder;
        }
        if (a.name !== b.name) {
            return String(a.name).localeCompare(String(b.name));
        }
        if (a.lat !== b.lat) {
            return a.lat - b.lat;
        }
        return a.lng - b.lng;
    });
}
