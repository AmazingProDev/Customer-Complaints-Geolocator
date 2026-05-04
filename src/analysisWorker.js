import * as turf from '@turf/turf';

const PLACE_GRID_CELL_SIZE = 0.25;
const PLACE_GRID_SEARCH_RADIUS = 4;
const HIGH_RISK_THRESHOLD = 60;
const SPATIAL_INDEX_CELL_SIZE = 0.5;
const CHUNK_SIZE = 200;

const COMPARISON_FIELDS = [
  {
    key: 'province',
    label: 'Province',
    computedKey: 'province',
    aliases: ['Province', 'Provice', 'PROVINCE']
  },
  {
    key: 'commune',
    label: 'Commune',
    computedKey: 'commune',
    aliases: ['Commune', 'COMMUNE']
  },
  {
    key: 'region',
    label: 'Region',
    computedKey: 'region',
    aliases: ['Region', 'Région', 'REGION']
  },
  {
    key: 'dr',
    label: 'DR',
    computedKey: 'dr',
    aliases: ['DR', 'Dr', 'Direction Régionale', 'Directions Régionales']
  }
];

const context = {
  layers: {
    regions: null,
    provinces: null,
    communes: null,
    drs: null
  },
  spatialIndexes: {
    regions: null,
    provinces: null,
    communes: null,
    drs: null
  },
  emergencyDataMap: new Map(),
  referencePlaces: [],
  referencePlaceGrid: new Map(),
  referencePlaceNameIndex: new Map(),
  referencePlaceAdminCache: new Map(),
  inhabitedAreas: []
};

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

function roundTo(value, decimals = 6) {
  return Number(Number(value).toFixed(decimals));
}

function getBBoxArea(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return Number.POSITIVE_INFINITY;
  return Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

function getSpatialIndexKey(lng, lat, cellSize = SPATIAL_INDEX_CELL_SIZE) {
  const x = Math.floor(lng / cellSize);
  const y = Math.floor(lat / cellSize);
  return `${x}:${y}`;
}

function buildSpatialFeatureIndex(features, cellSize = SPATIAL_INDEX_CELL_SIZE) {
  const buckets = new Map();

  features.forEach((feature) => {
    if (!feature?.bbox) return;

    const [minX, minY, maxX, maxY] = feature.bbox;
    const startX = Math.floor(minX / cellSize);
    const endX = Math.floor(maxX / cellSize);
    const startY = Math.floor(minY / cellSize);
    const endY = Math.floor(maxY / cellSize);

    for (let x = startX; x <= endX; x += 1) {
      for (let y = startY; y <= endY; y += 1) {
        const key = `${x}:${y}`;
        if (!buckets.has(key)) {
          buckets.set(key, []);
        }
        buckets.get(key).push(feature);
      }
    }
  });

  buckets.forEach((bucket) => {
    bucket.sort((a, b) => getBBoxArea(a.bbox) - getBBoxArea(b.bbox));
  });

  return {
    cellSize,
    buckets
  };
}

function calcBBoxes(featureCollection) {
  featureCollection?.features?.forEach((feature) => {
    if (!feature.bbox) {
      feature.bbox = turf.bbox(feature);
    }
  });
}

function buildSearchVariants(value) {
  const normalized = normalizeSearchText(value);
  const variants = [];

  if (!normalized) {
    return variants;
  }

  variants.push({ value: normalized, penalty: 0 });

  const relaxed = normalized
    .replace(/\+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (relaxed && relaxed !== normalized) {
    variants.push({ value: relaxed, penalty: 30 });
  }

  const compact = relaxed.replace(/\s+/g, '');
  if (compact && compact !== relaxed && compact !== normalized) {
    variants.push({ value: compact, penalty: 45 });
  }

  return variants;
}

function extractLocalityHints(value) {
  const raw = String(value || '').trim();
  const hints = new Set();

  if (!raw) {
    return [];
  }

  hints.add(raw);

  const parentheticalMatches = [...raw.matchAll(/\(([^)]+)\)/g)];
  parentheticalMatches.forEach((match) => {
    const inner = String(match[1] || '').trim();
    if (inner) {
      hints.add(inner);
    }
  });

  const normalizedHints = new Set();

  hints.forEach((hint) => {
    const normalized = normalizeSearchText(hint);
    if (normalized) {
      normalizedHints.add(normalized);
    }

    const relaxed = normalizeSearchText(
      hint
        .replace(/\+/g, ' ')
        .replace(/[()]/g, ' ')
        .replace(/n['’]/gi, 'n ')
    );

    if (relaxed) {
      normalizedHints.add(relaxed);
    }
  });

  const expandedHints = new Set();

  normalizedHints.forEach((hint) => {
    if (!hint) return;
    expandedHints.add(hint);

    const tokens = hint.split(' ').filter(Boolean);
    if (tokens.length > 1) {
      expandedHints.add(tokens.at(-1));
      expandedHints.add(tokens.slice(-2).join(' '));
    }

    if (tokens[0] === 'n' && tokens[1]) {
      expandedHints.add(tokens.slice(1).join(' '));
      expandedHints.add(tokens[1]);
    }

    if (hint.startsWith('n ') && hint.length > 2) {
      expandedHints.add(hint.slice(2).trim());
    }
  });

  return [...expandedHints].filter(Boolean);
}

function expandAliasForms(alias) {
  const forms = new Set();
  const normalized = normalizeSearchText(alias);

  if (!normalized) {
    return [];
  }

  forms.add(normalized);

  if (normalized.length >= 5 && /[ea]$/.test(normalized)) {
    forms.add(normalized.slice(0, -1));
  }

  if (normalized.length >= 6 && normalized.endsWith('te')) {
    forms.add(normalized.slice(0, -1));
  }

  return [...forms].filter(Boolean);
}

function getPlaceGridKey(lng, lat) {
  const x = Math.floor(lng / PLACE_GRID_CELL_SIZE);
  const y = Math.floor(lat / PLACE_GRID_CELL_SIZE);
  return `${x}:${y}`;
}

function buildReferencePlaceGrid(places) {
  const grid = new Map();

  places.forEach((place) => {
    const key = getPlaceGridKey(place.lng, place.lat);
    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push(place);
  });

  return grid;
}

function extractReferencePlaceAliases(name) {
  const aliases = new Set();
  buildSearchVariants(name).forEach((variant) => {
    const normalizedFull = variant.value;
    if (!normalizedFull) return;

    expandAliasForms(normalizedFull).forEach((form) => aliases.add(form));
    normalizedFull.split(' ').forEach((token) => {
      if (token.length >= 3) {
        expandAliasForms(token).forEach((form) => aliases.add(form));
      }
    });
  });

  const latinPrefix = String(name || '').match(/^[A-Za-zÀ-ÿ0-9'’\-\s]+/);
  const normalizedLatinPrefix = normalizeSearchText(latinPrefix ? latinPrefix[0] : '');
  if (normalizedLatinPrefix) {
    expandAliasForms(normalizedLatinPrefix).forEach((form) => aliases.add(form));
  }

  return [...aliases];
}

function buildReferencePlaceNameIndex(places) {
  const index = new Map();

  places.forEach((place) => {
    extractReferencePlaceAliases(place.name).forEach((alias) => {
      if (!index.has(alias)) {
        index.set(alias, []);
      }
      index.get(alias).push(place);
    });
  });

  return index;
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestReferencePlace(lat, lng) {
  if (!context.referencePlaces.length) {
    return null;
  }

  const cellX = Math.floor(lng / PLACE_GRID_CELL_SIZE);
  const cellY = Math.floor(lat / PLACE_GRID_CELL_SIZE);
  let bestMatch = null;

  for (let radius = 0; radius <= PLACE_GRID_SEARCH_RADIUS; radius += 1) {
    let foundInRing = false;

    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const key = `${cellX + dx}:${cellY + dy}`;
        const candidates = context.referencePlaceGrid.get(key);
        if (!candidates) continue;

        foundInRing = true;
        candidates.forEach((candidate) => {
          const distanceKm = haversineDistanceKm(lat, lng, candidate.lat, candidate.lng);
          if (!bestMatch || distanceKm < bestMatch.distanceKm) {
            bestMatch = {
              ...candidate,
              distanceKm
            };
          }
        });
      }
    }

    if (foundInRing && bestMatch) {
      return bestMatch;
    }
  }

  return context.referencePlaces.reduce((best, candidate) => {
    const distanceKm = haversineDistanceKm(lat, lng, candidate.lat, candidate.lng);
    if (!best || distanceKm < best.distanceKm) {
      return {
        ...candidate,
        distanceKm
      };
    }
    return best;
  }, null);
}

function getSpatialFeatureName(feature) {
  return feature?.properties?.Nom_Region
    || feature?.properties?.Nom_region
    || feature?.properties?.Nom_Provin
    || feature?.properties?.Nom_provin
    || feature?.properties?.Nom_Commun
    || feature?.properties?.Nom_commun
    || feature?.properties?.NAME
    || 'N/A';
}

function findLayerMatchValueForCoordinates(lat, lng, layer, spatialIndex = null) {
  if (!layer?.features) return 'N/A';

  const pointFeature = turf.point([lng, lat]);
  const candidateFeatures = spatialIndex?.buckets?.get(getSpatialIndexKey(lng, lat, spatialIndex.cellSize)) || layer.features;

  for (const feature of candidateFeatures) {
    if (feature.bbox) {
      const [minX, minY, maxX, maxY] = feature.bbox;
      if (lng < minX || lng > maxX || lat < minY || lat > maxY) {
        continue;
      }
    }

    if (turf.booleanPointInPolygon(pointFeature, feature)) {
      return getSpatialFeatureName(feature);
    }
  }

  return 'N/A';
}

function getAdminContextForCoordinates(lat, lng) {
  return {
    region: findLayerMatchValueForCoordinates(lat, lng, context.layers.regions, context.spatialIndexes.regions),
    dr: findLayerMatchValueForCoordinates(lat, lng, context.layers.drs, context.spatialIndexes.drs),
    province: findLayerMatchValueForCoordinates(lat, lng, context.layers.provinces, context.spatialIndexes.provinces),
    commune: findLayerMatchValueForCoordinates(lat, lng, context.layers.communes, context.spatialIndexes.communes)
  };
}

function getReferencePlaceCacheKey(place) {
  return place.osmId || `${normalizeSearchText(place.name)}|${roundTo(place.lat, 6)}|${roundTo(place.lng, 6)}`;
}

function getReferencePlaceAdminContext(place) {
  const key = getReferencePlaceCacheKey(place);
  if (context.referencePlaceAdminCache.has(key)) {
    return context.referencePlaceAdminCache.get(key);
  }

  const adminContext = getAdminContextForCoordinates(place.lat, place.lng);
  context.referencePlaceAdminCache.set(key, adminContext);
  return adminContext;
}

function getLocalityReferenceCandidates(localityName) {
  const candidates = new Map();

  extractLocalityHints(localityName).forEach((hint) => {
    buildSearchVariants(hint).forEach((variant) => {
      const query = variant.value;
      if (!query) return;

      const aliasKeys = new Set([query]);
      query.split(' ').forEach((token) => {
        if (token.length >= 3) {
          aliasKeys.add(token);
        }
      });

      aliasKeys.forEach((alias) => {
        expandAliasForms(alias).forEach((aliasForm) => {
          const places = context.referencePlaceNameIndex.get(aliasForm) || [];
          places.forEach((place) => {
            candidates.set(getReferencePlaceCacheKey(place), place);
          });
        });
      });
    });
  });

  return [...candidates.values()];
}

function scoreSearchField(query, candidate) {
  if (!query || !candidate) return -1;
  const queryTokens = query.split(' ').filter(Boolean);
  if (candidate === query) return 1000;
  if (candidate.startsWith(query)) return 850;
  if (queryTokens.length > 1 && queryTokens.every((token) => candidate.includes(token))) return 780;
  if (candidate.includes(` ${query}`)) return 760;
  if (candidate.includes(query)) return 700;
  return -1;
}

function getBestLocalityReferenceScore(localityName, placeName) {
  const queryVariants = extractLocalityHints(localityName).flatMap((hint) => buildSearchVariants(hint));
  const candidateVariants = extractReferencePlaceAliases(placeName).map((alias) => ({ value: alias, penalty: 0 }));
  let bestScore = -1;
  let isExact = false;

  queryVariants.forEach((queryVariant) => {
    candidateVariants.forEach((candidateVariant) => {
      const score = scoreSearchField(queryVariant.value, candidateVariant.value);
      if (score < 0) return;

      const adjustedScore = score - queryVariant.penalty - candidateVariant.penalty;
      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        isExact = queryVariant.penalty === 0 && candidateVariant.value === queryVariant.value;
      } else if (adjustedScore === bestScore && queryVariant.penalty === 0 && candidateVariant.value === queryVariant.value) {
        isExact = true;
      }
    });
  });

  return { score: bestScore, isExact };
}

function findOriginalFieldValue(original, aliases) {
  if (!original) return '';

  const keys = Object.keys(original);
  for (const alias of aliases) {
    const directValue = original[alias];
    if (directValue != null && String(directValue).trim() !== '') {
      return String(directValue).trim();
    }
  }

  for (const key of keys) {
    const normalizedKey = normalizeName(key);
    if (aliases.some((alias) => normalizeName(alias) === normalizedKey)) {
      const value = original[key];
      if (value != null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
  }

  return '';
}

function findLocalityReferencePlace(point) {
  const localityRawName = point.original?.Localite || point.displayName || '';
  const localityName = normalizeSearchText(localityRawName);
  if (!localityName) return null;

  const candidates = getLocalityReferenceCandidates(localityRawName);
  if (!candidates.length) return null;

  const desiredProvince = normalizeSearchText(
    findOriginalFieldValue(point.original, ['Province', 'Provice', 'PROVINCE']) || point.province
  );
  const desiredCommune = normalizeSearchText(
    findOriginalFieldValue(point.original, ['Commune', 'COMMUNE']) || point.commune
  );

  const scoredMatches = [];

  candidates.forEach((candidate) => {
    const adminContext = getReferencePlaceAdminContext(candidate);
    const candidateProvince = normalizeSearchText(adminContext.province);
    const candidateCommune = normalizeSearchText(adminContext.commune);

    if (desiredProvince && candidateProvince !== desiredProvince) {
      return;
    }

    if (desiredCommune && candidateCommune !== desiredCommune) {
      return;
    }

    const matchScore = getBestLocalityReferenceScore(localityRawName, candidate.name);
    if (matchScore.score < 0) {
      return;
    }

    const distanceKm = haversineDistanceKm(point.lat, point.lng, candidate.lat, candidate.lng);
    scoredMatches.push({
      ...candidate,
      ...adminContext,
      distanceKm,
      matchScore: matchScore.score,
      isExactMatch: matchScore.isExact
    });
  });

  scoredMatches.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (a.isExactMatch !== b.isExactMatch) return a.isExactMatch ? -1 : 1;
    return a.distanceKm - b.distanceKm;
  });

  return scoredMatches[0] || null;
}

function applyLocalityReferenceToPoint(point, localityReference, sourceLabel = 'Lieux reference', sourceUrl = '') {
  if (!point || !localityReference) return;
  point.localityReferenceName = localityReference.name || null;
  point.localityReferenceDistanceKm = localityReference.distanceKm ?? null;
  point.localityReferenceClass = localityReference.fclass || localityReference.subLabel || null;
  point.localityReferenceExactMatch = Boolean(localityReference.isExactMatch);
  point.localityReferenceLat = localityReference.lat ?? null;
  point.localityReferenceLng = localityReference.lng ?? null;
  point.localityReferenceSource = sourceLabel;
  point.localityReferenceUrl = sourceUrl || localityReference.url || '';
}

function findInhabitedAreaContext(lat, lng) {
  if (!context.inhabitedAreas.length) {
    return {
      isInsideInhabitedArea: false,
      inhabitedAreaName: null,
      inhabitedAreaClass: null,
      nearestInhabitedAreaName: null,
      nearestInhabitedAreaClass: null,
      nearestInhabitedAreaDistanceKm: null
    };
  }

  const pointFeature = turf.point([lng, lat]);
  let containingArea = null;
  let nearestArea = null;

  context.inhabitedAreas.forEach((area) => {
    const distanceKm = haversineDistanceKm(lat, lng, area.centroid.lat, area.centroid.lng);
    if (!nearestArea || distanceKm < nearestArea.distanceKm) {
      nearestArea = {
        ...area,
        distanceKm
      };
    }

    if (Array.isArray(area.bbox) && area.bbox.length === 4) {
      const [minX, minY, maxX, maxY] = area.bbox;
      if (lng < minX || lng > maxX || lat < minY || lat > maxY) {
        return;
      }
    }

    if (turf.booleanPointInPolygon(pointFeature, area.feature)) {
      if (!containingArea || getBBoxArea(area.bbox) < getBBoxArea(containingArea.bbox)) {
        containingArea = area;
      }
    }
  });

  return {
    isInsideInhabitedArea: Boolean(containingArea),
    inhabitedAreaName: containingArea?.name || null,
    inhabitedAreaClass: containingArea?.fclass || null,
    nearestInhabitedAreaName: (containingArea || nearestArea)?.name || null,
    nearestInhabitedAreaClass: (containingArea || nearestArea)?.fclass || null,
    nearestInhabitedAreaDistanceKm: containingArea ? 0 : (nearestArea?.distanceKm ?? null)
  };
}

function getRiskLevel(score) {
  if (score >= HIGH_RISK_THRESHOLD) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function computeReviewRisk(point) {
  let score = 0;
  const reasons = [];

  if (point._hasGeographyDivergence) {
    score += 35;
    reasons.push(`geography divergence (${point._divergenceFields.join(', ')})`);
  }

  const confidence = Number(point.normalization?.normalizationConfidence ?? 1);
  if (confidence < 0.5) {
    score += 25;
    reasons.push(`low normalization confidence (${confidence.toFixed(2)})`);
  } else if (confidence < 0.85) {
    score += 10;
    reasons.push(`medium normalization confidence (${confidence.toFixed(2)})`);
  }

  if (point.commune === 'N/A' || point.province === 'N/A') {
    score += 20;
    reasons.push('calculated commune/province missing');
  }

  if (!point.isInsideInhabitedArea) {
    score += 15;
    reasons.push('outside inhabited area polygon');
  }

  if (Number.isFinite(point.nearestInhabitedAreaDistanceKm)) {
    if (point.nearestInhabitedAreaDistanceKm > 10) {
      score += 20;
      reasons.push('far from nearest inhabited area');
    } else if (point.nearestInhabitedAreaDistanceKm > 5) {
      score += 12;
      reasons.push('moderately far from inhabited area');
    } else if (point.nearestInhabitedAreaDistanceKm > 2) {
      score += 6;
      reasons.push('slightly far from inhabited area');
    }
  }

  if (Number.isFinite(point.nearestPlaceDistanceKm)) {
    if (point.nearestPlaceDistanceKm > 10) {
      score += 15;
      reasons.push('far from nearest named place');
    } else if (point.nearestPlaceDistanceKm > 5) {
      score += 8;
      reasons.push('moderately far from nearest named place');
    } else if (point.nearestPlaceDistanceKm > 2) {
      score += 4;
      reasons.push('slightly far from nearest named place');
    }
  }

  const boundedScore = Math.min(100, score);
  return {
    score: boundedScore,
    level: getRiskLevel(boundedScore),
    reasons
  };
}

function applyReviewRisk(point) {
  const risk = computeReviewRisk(point);
  point.reviewRiskScore = risk.score;
  point.reviewRiskLevel = risk.level;
  point.reviewRiskReasons = risk.reasons;
}

function buildComparisonReport(points) {
  const countDifferences = [];
  const rowDivergences = [];

  points.forEach((point) => {
    point._divergenceFields = [];
    point._hasGeographyDivergence = false;
  });

  COMPARISON_FIELDS.forEach((field) => {
    const originalCounts = new Map();
    const calculatedCounts = new Map();
    const displayLabels = new Map();
    let hasOriginalData = false;

    points.forEach((point) => {
      const originalValue = findOriginalFieldValue(point.original, field.aliases);
      const calculatedValue = point[field.computedKey];

      if (originalValue) {
        hasOriginalData = true;
        const originalKey = normalizeName(originalValue);
        originalCounts.set(originalKey, (originalCounts.get(originalKey) || 0) + 1);
        if (!displayLabels.has(originalKey)) {
          displayLabels.set(originalKey, originalValue);
        }
      }

      if (calculatedValue && calculatedValue !== 'N/A') {
        const calculatedKey = normalizeName(calculatedValue);
        calculatedCounts.set(calculatedKey, (calculatedCounts.get(calculatedKey) || 0) + 1);
        if (!displayLabels.has(calculatedKey)) {
          displayLabels.set(calculatedKey, calculatedValue);
        }
      }

      if (originalValue) {
        const originalKey = normalizeName(originalValue);
        const calculatedKey = normalizeName(calculatedValue);
        if (originalKey !== calculatedKey) {
          point._divergenceFields.push(field.label);
          point._hasGeographyDivergence = true;
          rowDivergences.push({
            code: point.original?.Code || point.id,
            locality: point.original?.Localite || point.displayName || point.id,
            field: field.label,
            original: originalValue,
            calculated: calculatedValue || 'N/A',
            nearestPlace: point.nearestPlaceName || '',
            nearestPlaceDistanceKm: point.nearestPlaceDistanceKm ?? null,
            inhabitedArea: point.isInsideInhabitedArea
              ? (point.inhabitedAreaName || '')
              : (point.nearestInhabitedAreaName || ''),
            inhabitedAreaDistanceKm: point.isInsideInhabitedArea
              ? 0
              : (point.nearestInhabitedAreaDistanceKm ?? null),
            isInsideInhabitedArea: point.isInsideInhabitedArea
          });
        }
      }
    });

    if (!hasOriginalData) {
      return;
    }

    const allKeys = new Set([...originalCounts.keys(), ...calculatedCounts.keys()]);
    allKeys.forEach((key) => {
      const originalCount = originalCounts.get(key) || 0;
      const calculatedCount = calculatedCounts.get(key) || 0;
      if (originalCount !== calculatedCount) {
        countDifferences.push({
          field: field.label,
          value: displayLabels.get(key) || key,
          originalCount,
          calculatedCount,
          difference: calculatedCount - originalCount
        });
      }
    });
  });

  countDifferences.sort((a, b) => {
    if (a.field !== b.field) return a.field.localeCompare(b.field);
    const delta = Math.abs(b.difference) - Math.abs(a.difference);
    if (delta !== 0) return delta;
    return a.value.localeCompare(b.value);
  });

  rowDivergences.sort((a, b) => {
    if (a.field !== b.field) return a.field.localeCompare(b.field);
    return String(a.code).localeCompare(String(b.code));
  });

  return { countDifferences, rowDivergences };
}

function initializeWorker(payload) {
  context.layers = payload.layers || context.layers;
  context.inhabitedAreas = payload.inhabitedAreas || [];
  context.referencePlaces = payload.referencePlaces || [];
  context.referencePlaceGrid = buildReferencePlaceGrid(context.referencePlaces);
  context.referencePlaceNameIndex = buildReferencePlaceNameIndex(context.referencePlaces);
  context.referencePlaceAdminCache = new Map();
  context.emergencyDataMap = new Map();

  (payload.emergencyData || []).forEach((row) => {
    const rowCommune = row['Commune SS'] || row['Commune'] || row['COMMUNE'];
    if (rowCommune) {
      context.emergencyDataMap.set(normalizeName(rowCommune), row);
    }
  });

  Object.values(context.layers).forEach((layer) => {
    if (layer?.features) {
      calcBBoxes(layer);
    }
  });

  context.spatialIndexes = {
    regions: context.layers.regions?.features ? buildSpatialFeatureIndex(context.layers.regions.features) : null,
    provinces: context.layers.provinces?.features ? buildSpatialFeatureIndex(context.layers.provinces.features) : null,
    communes: context.layers.communes?.features ? buildSpatialFeatureIndex(context.layers.communes.features) : null,
    drs: context.layers.drs?.features ? buildSpatialFeatureIndex(context.layers.drs.features) : null
  };
}

function analyzePayload(payload, requestId) {
  const points = payload.points || [];
  const localityReferenceOverrides = new Map(
    (payload.localityReferenceOverrides || []).map(([id, override]) => [String(id), override])
  );
  const processedPoints = [];
  let matchedCount = 0;
  let emptySSCount = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const { region, dr, province, commune } = getAdminContextForCoordinates(point.lat, point.lng);

    const emergencyInfo = {
      '141': '',
      '5757': '',
      '15': '',
      '19': '',
      '112': '',
      '177': ''
    };

    if (commune !== 'N/A') {
      const match = context.emergencyDataMap.get(normalizeName(commune));
      if (match) {
        if (match['141']) emergencyInfo['141'] = match['141'];
        if (match['5757']) emergencyInfo['5757'] = match['5757'];
        if (match['15']) emergencyInfo['15'] = match['15'];
        if (match['19']) emergencyInfo['19'] = match['19'];
        if (match['112']) emergencyInfo['112'] = match['112'];
        if (match['177']) emergencyInfo['177'] = match['177'];
      }
    }

    const result = {
      ...point,
      localityReferenceName: null,
      localityReferenceDistanceKm: null,
      localityReferenceClass: null,
      localityReferenceExactMatch: false,
      localityReferenceLat: null,
      localityReferenceLng: null,
      localityReferenceSource: null,
      localityReferenceUrl: '',
      nearestPlaceName: null,
      nearestPlaceDistanceKm: null,
      nearestPlaceClass: null,
      nearestPlaceLat: null,
      nearestPlaceLng: null,
      isInsideInhabitedArea: false,
      inhabitedAreaName: null,
      inhabitedAreaClass: null,
      nearestInhabitedAreaName: null,
      nearestInhabitedAreaClass: null,
      nearestInhabitedAreaDistanceKm: null,
      reviewRiskScore: 0,
      reviewRiskLevel: 'Low',
      reviewRiskReasons: [],
      region,
      dr,
      province,
      commune,
      ...emergencyInfo
    };

    const nearestPlace = findNearestReferencePlace(point.lat, point.lng);
    if (nearestPlace) {
      result.nearestPlaceName = nearestPlace.name;
      result.nearestPlaceDistanceKm = nearestPlace.distanceKm;
      result.nearestPlaceClass = nearestPlace.fclass;
      result.nearestPlaceLat = nearestPlace.lat;
      result.nearestPlaceLng = nearestPlace.lng;
    }

    const localityReference = findLocalityReferencePlace(result);
    const localityOverride = localityReferenceOverrides.get(String(result.id));
    if (localityOverride) {
      applyLocalityReferenceToPoint(result, localityOverride, 'Wikimapia', localityOverride.url);
    } else if (localityReference) {
      applyLocalityReferenceToPoint(result, localityReference, 'Lieux reference');
    }

    Object.assign(result, findInhabitedAreaContext(point.lat, point.lng));

    if (commune !== 'N/A' || province !== 'N/A') {
      matchedCount += 1;
    }

    const hasSSData = emergencyInfo['141'] || emergencyInfo['5757'] || emergencyInfo['15'] || emergencyInfo['19'] || emergencyInfo['112'] || emergencyInfo['177'];
    result._isEmptySS = !hasSSData;
    if (!hasSSData) {
      emptySSCount += 1;
    }

    processedPoints.push(result);

    if ((index + 1) % CHUNK_SIZE === 0 || index === points.length - 1) {
      self.postMessage({
        type: 'progress',
        requestId,
        payload: {
          processedCount: index + 1,
          total: points.length,
          matchedCount,
          emptySSCount
        }
      });
    }
  }

  const comparisonReport = buildComparisonReport(processedPoints);
  processedPoints.forEach((point) => applyReviewRisk(point));

  self.postMessage({
    type: 'complete',
    requestId,
    payload: {
      processedPoints,
      comparisonReport,
      matchedCount,
      emptySSCount
    }
  });
}

self.onmessage = (event) => {
  const { type, payload, requestId } = event.data || {};

  try {
    if (type === 'init') {
      initializeWorker(payload || {});
      self.postMessage({ type: 'ready' });
      return;
    }

    if (type === 'analyze') {
      analyzePayload(payload || {}, requestId);
      return;
    }

    throw new Error(`Unknown worker message type: ${type}`);
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
