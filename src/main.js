import './style.css';
import * as L from 'leaflet';
import * as turf from '@turf/turf';
import 'leaflet-control-geocoder/dist/Control.Geocoder.css';
import 'leaflet-control-geocoder';

const SITE_BDD_CONFIG = {
    '2G': {
        label: 'BDD 2G',
        siteField: 'BTSName',
        sectorField: 'CELLNAME',
        defaultColor: '#2b19ff',
        defaultShowSiteNames: false,
        defaultSettings: {
            siteRadius: 6,
            siteOpacity: 0.72,
            sectorLengthKm: 0.07,
            sectorHalfAngle: 18,
            sectorOpacity: 1,
            labelTextColor: '#ffffff',
            labelBackgroundColor: '#2b19ff',
            labelBackgroundOpacity: 0.88
        }
    },
    '3G': {
        label: 'BDD 3G',
        siteField: 'NODEBName',
        sectorField: 'CELLNAME',
        defaultColor: '#00ff38',
        defaultShowSiteNames: false,
        defaultSettings: {
            siteRadius: 8,
            siteOpacity: 0.72,
            sectorLengthKm: 0.08,
            sectorHalfAngle: 18,
            sectorOpacity: 0.95,
            labelTextColor: '#020617',
            labelBackgroundColor: '#f6f3ef',
            labelBackgroundOpacity: 0.92
        }
    },
    '4G': {
        label: 'BDD 4G',
        siteField: 'BaseStationName',
        sectorField: 'CellName',
        defaultColor: '#ff3b6b',
        defaultShowSiteNames: true,
        defaultSettings: {
            siteRadius: 10,
            siteOpacity: 0.72,
            sectorLengthKm: 0.09,
            sectorHalfAngle: 18,
            sectorOpacity: 1,
            labelTextColor: '#ffffff',
            labelBackgroundColor: '#111111',
            labelBackgroundOpacity: 0.35
        }
    }
};

const NETWORK_BADGE_OPTIONS = Object.freeze(['2G', '2G/3G', '2G/3G/4G', '2G/3G/4G/5G', 'NC']);

function createEmptySiteBddDataset(tech) {
    const config = SITE_BDD_CONFIG[tech];
    return {
        tech,
        label: config.label,
        color: config.defaultColor,
        visible: false,
        settingsOpen: false,
        showSiteNames: Boolean(config.defaultShowSiteNames),
        settings: createDefaultSiteBddRenderSettings(tech),
        sites: [],
        sectors: [],
        siteGrid: new Map(),
        sectorGrid: new Map()
    };
}

const SITE_BDD_DEFAULT_SETTINGS = Object.freeze({
    siteRadius: 4,
    siteOpacity: 0.72,
    sectorLengthKm: 0.8,
    sectorHalfAngle: 18,
    sectorOpacity: 0.2,
    labelTextColor: '#ffffff',
    labelBackgroundColor: '#020617',
    labelBackgroundOpacity: 0.82
});
const SITE_BDD_TECH_ORDER = Object.freeze(['2G', '3G', '4G']);
const CUSTOM_SITE_OVERLAY_COLORS = Object.freeze([
    '#f97316',
    '#22c55e',
    '#38bdf8',
    '#facc15',
    '#e879f9',
    '#fb7185'
]);
const DEFAULT_SITE_BDD_DATA_URL = './data/site_bdd_builtin.json';

function createDefaultSiteBddRenderSettings(tech) {
    const techDefaults = tech ? SITE_BDD_CONFIG[tech]?.defaultSettings : null;
    return {
        ...SITE_BDD_DEFAULT_SETTINGS,
        ...(techDefaults || {})
    };
}

// --- State ---
const state = {
    layers: {
        regions: null,
        provinces: null,
        communes: null,
        drs: null // aggregated GeoJSON
    },
    drColors: {}, // Map<drName, color>
    drToProvinces: {}, // Map<drName, [provinceNames]>
    regionColors: {}, // Map<regionName, color>
    emergencyData: [], // Array of rows from emergency excel
    emergencyDataMap: new Map(), // Map<normalized_commune, row>
    spatialIndexes: {
        regions: null,
        provinces: null,
        communes: null,
        drs: null
    },
    referencePlaces: [],
    referencePlaceGrid: new Map(),
    referencePlaceNameIndex: new Map(),
    referencePlaceAdminCache: new Map(),
    inhabitedAreas: [],
    mapLayerGroups: {
        regions: L.layerGroup(),
        drs: L.layerGroup(),
        provinces: L.layerGroup(),
        communes: L.layerGroup(),
        points: L.layerGroup(),
        focus: L.layerGroup(),
        manualSites: L.layerGroup(),
        ruler: L.layerGroup(),
        rulerHandles: L.layerGroup(),
        textAnnotations: L.layerGroup(),
        drawings: L.layerGroup(),
        drawingHandles: L.layerGroup(),
        customSiteOverlays: L.layerGroup(),
        siteBdds: {
            '2G': L.layerGroup(),
            '3G': L.layerGroup(),
            '4G': L.layerGroup()
        }
    },
    points: [], // Array of { id, lat, lng, properties... }
    processedPoints: [], // Array of { ...original, region, province, commune }
    importSummary: null,
    filteredPoints: [],
    manualSites: [],
    draw: {
        mode: null,
        selectedId: null,
        activeDraft: null,
        annotations: [],
        defaultStyle: {
            color: '#22c55e',
            width: 4,
            opacity: 0.95,
            fillOpacity: 0.2,
            dashed: false
        }
    },
    ruler: {
        active: false,
        currentPoints: [],
        measurements: [],
        selectedId: null
    },
    textAnnotations: [],
    textTool: {
        placing: false,
        selectedId: null
    },
    auditFilter: null,
    searchCircle: null,
    activePointId: null,
    searchRequestId: 0,
    wikimapiaCache: new Map(),
    localityReferenceOverrides: new Map(),
    geoDataLoaded: false,
    siteBdd: createEmptySiteBddState(),
    customSiteOverlays: [],
    visibleNetworkBadges: new Set(NETWORK_BADGE_OPTIONS),
    comparisonReport: {
        countDifferences: [],
        rowDivergences: []
    }
};

const BADGE_MIN_ZOOM = 9;
const PLACE_GRID_CELL_SIZE = 0.25;
const PLACE_GRID_SEARCH_RADIUS = 4;
const HIGH_RISK_THRESHOLD = 60;
const SEARCH_DEBOUNCE_MS = 250;
const SPATIAL_INDEX_CELL_SIZE = 0.5;
const SITE_BDD_GRID_CELL_SIZE = 0.25;
const SITE_BDD_SECTOR_MIN_ZOOM = 10;
const SITE_BDD_SECTOR_RENDER_LIMIT = 6000;
const WIKIMAPIA_RESULT_LIMIT = 5;
let markerRenderFrame = null;
let searchInputTimer = null;
let xlsxModulePromise = null;
let coordinateNormalizerModulePromise = null;
let analysisWorker = null;
let analysisWorkerInitPromise = null;
let analysisRequestCounter = 0;
let badgePopoverDragState = null;
let badgePopoverPosition = null;
let textPopoverDragState = null;
let textPopoverPosition = null;
let drawPopoverDragState = null;
let drawPopoverPosition = null;
let legendDragState = null;
let legendPosition = null;
const siteBddCanvasRenderer = L.canvas({ padding: 0.4 });

function loadXlsxModule() {
    if (!xlsxModulePromise) {
        xlsxModulePromise = import('xlsx');
    }
    return xlsxModulePromise;
}

function loadCoordinateNormalizerModule() {
    if (!coordinateNormalizerModulePromise) {
        coordinateNormalizerModulePromise = import('./coordinateNormalizer');
    }
    return coordinateNormalizerModulePromise;
}

function resetAnalysisWorker() {
    if (analysisWorker) {
        analysisWorker.terminate();
    }
    analysisWorker = null;
    analysisWorkerInitPromise = null;
}

function getAnalysisWorkerContextPayload() {
    return {
        layers: {
            regions: state.layers.regions,
            provinces: state.layers.provinces,
            communes: state.layers.communes,
            drs: state.layers.drs
        },
        emergencyData: state.emergencyData,
        referencePlaces: state.referencePlaces,
        inhabitedAreas: state.inhabitedAreas
    };
}

function ensureAnalysisWorker() {
    if (analysisWorkerInitPromise) {
        return analysisWorkerInitPromise;
    }

    analysisWorker = new Worker(new URL('./analysisWorker.js', import.meta.url), { type: 'module' });

    analysisWorkerInitPromise = new Promise((resolve, reject) => {
        const handleMessage = (event) => {
            if (event.data?.type !== 'ready') return;
            cleanup();
            resolve(analysisWorker);
        };

        const handleError = (error) => {
            cleanup();
            resetAnalysisWorker();
            reject(error);
        };

        const cleanup = () => {
            analysisWorker?.removeEventListener('message', handleMessage);
            analysisWorker?.removeEventListener('error', handleError);
        };

        analysisWorker.addEventListener('message', handleMessage);
        analysisWorker.addEventListener('error', handleError);
        analysisWorker.postMessage({
            type: 'init',
            payload: getAnalysisWorkerContextPayload()
        });
    });

    return analysisWorkerInitPromise;
}

// --- Initialization ---
const map = L.map('map').setView([31.7917, -7.0926], 6); // Centered on Morocco

// --- Base Maps ---
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
});

const googleSat = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
});

const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
});

const googleTerrain = L.tileLayer('https://{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
});

// Set distinct base maps
const baseMaps = {
    "Standard": osm,
    "Satellite": googleSat,
    "Hybrid": googleHybrid,
    "Terrain": googleTerrain
};

// Add default layer
googleHybrid.addTo(map);

// Add layer control
L.control.layers(baseMaps).addTo(map);

// Add Geocoder
L.Control.geocoder({
    defaultMarkGeocode: false
})
    .on('markgeocode', function (e) {
        const bbox = e.geocode.bbox;
        const poly = L.polygon([
            bbox.getSouthEast(),
            bbox.getNorthEast(),
            bbox.getNorthWest(),
            bbox.getSouthWest()
        ]).addTo(map);
        map.fitBounds(poly.getBounds());
    })
    .addTo(map);

// Add layer groups to map
state.mapLayerGroups.regions.addTo(map);
state.mapLayerGroups.drs.addTo(map);
// Provinces and Communes hidden by default to avoid clutter, but groups must be strictly added if we want them togglable
state.mapLayerGroups.provinces.addTo(map);
state.mapLayerGroups.communes.addTo(map);
state.mapLayerGroups.points.addTo(map);
state.mapLayerGroups.focus.addTo(map);
state.mapLayerGroups.manualSites.addTo(map);
state.mapLayerGroups.ruler.addTo(map);
state.mapLayerGroups.rulerHandles.addTo(map);
state.mapLayerGroups.textAnnotations.addTo(map);
state.mapLayerGroups.drawings.addTo(map);
state.mapLayerGroups.drawingHandles.addTo(map);
state.mapLayerGroups.customSiteOverlays.addTo(map);
Object.values(state.mapLayerGroups.siteBdds).forEach((group) => group.addTo(map));

// --- DOM Elements ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const importSitesBtn = document.getElementById('importSitesBtn');
const clearSitesBtn = document.getElementById('clearSitesBtn');
const clearSitesBtnCompact = document.getElementById('clearSitesBtnCompact');
const sitesFileInput = document.getElementById('sitesFileInput');
const importKmlSitesBtn = document.getElementById('importKmlSitesBtn');
const clearKmlSitesBtn = document.getElementById('clearKmlSitesBtn');
const clearKmlSitesBtnCompact = document.getElementById('clearKmlSitesBtnCompact');
const kmlSitesFileInput = document.getElementById('kmlSitesFileInput');
const kmlSitesSummaryText = document.getElementById('kmlSitesSummaryText');
const kmlSiteOverlayList = document.getElementById('kmlSiteOverlayList');
const bddLayerGrid = document.getElementById('bddLayerGrid');
const toggleBadgesBtn = document.getElementById('toggleBadgesBtn');
const badgeFilterPopover = document.getElementById('badgeFilterPopover');
const badgeFilterPopoverHeader = document.getElementById('badgeFilterPopoverHeader');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const importSummaryText = document.getElementById('importSummaryText');
const sitesImportSummaryText = document.getElementById('sitesImportSummaryText');
const sitesRenderHint = document.getElementById('sitesRenderHint');
const siteBddLegendName = document.getElementById('siteBddLegendName');
const bddModeSites = document.getElementById('bddModeSites');
const bddModeSectors = document.getElementById('bddModeSectors');
const globalSectorLengthScaleInput = document.getElementById('globalSectorLengthScaleInput');
const globalSectorLengthScaleValue = document.getElementById('globalSectorLengthScaleValue');
const toggleOverlayLayersBtn = document.getElementById('toggleOverlayLayersBtn');
const overlayLayersContent = document.getElementById('overlayLayersContent');
const toggleImportedOverlaysBtn = document.getElementById('toggleImportedOverlaysBtn');
const importedOverlaysContent = document.getElementById('importedOverlaysContent');
const toggleBdd2G = document.getElementById('toggleBdd2G');
const toggleBdd3G = document.getElementById('toggleBdd3G');
const toggleBdd4G = document.getElementById('toggleBdd4G');
const colorBdd2G = document.getElementById('colorBdd2G');
const colorBdd3G = document.getElementById('colorBdd3G');
const colorBdd4G = document.getElementById('colorBdd4G');
const countBdd2G = document.getElementById('countBdd2G');
const countBdd3G = document.getElementById('countBdd3G');
const countBdd4G = document.getElementById('countBdd4G');
const toggleRegions = document.getElementById('toggleRegions');
const toggleDRs = document.getElementById('toggleDRs');
const toggleProvinces = document.getElementById('toggleProvinces');
const toggleCommunes = document.getElementById('toggleCommunes');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const comparisonGrid = document.getElementById('comparisonGrid');
const countDivergenceSummary = document.getElementById('countDivergenceSummary');
const rowDivergenceSummary = document.getElementById('rowDivergenceSummary');
const countDivergenceTableBody = document.querySelector('#countDivergenceTable tbody');
const rowDivergenceTableBody = document.querySelector('#rowDivergenceTable tbody');
const totalPointsEl = document.getElementById('totalPoints');
const drLegend = document.getElementById('drLegend');
const matchedPointsEl = document.getElementById('matchedPoints');
const emptySSPointsEl = document.getElementById('emptySSPoints');
const filtersCard = document.getElementById('filtersCard');
const toggleHierarchyLayersBtn = document.getElementById('toggleHierarchyLayersBtn');
const hierarchyLayersContent = document.getElementById('hierarchyLayersContent');
const toggleFiltersBtn = document.getElementById('toggleFiltersBtn');
const filtersContent = document.getElementById('filtersContent');
const filterEmptySS = document.getElementById('filterEmptySS');
const filterGeographyDivergence = document.getElementById('filterGeographyDivergence');
const filterHighRisk = document.getElementById('filterHighRisk');
const filterFocusCircles = document.getElementById('filterFocusCircles');
const auditFilterBar = document.getElementById('auditFilterBar');
const auditFilterLabel = document.getElementById('auditFilterLabel');
const clearAuditFilterBtn = document.getElementById('clearAuditFilterBtn');
// const statsCard = document.getElementById('statsCard');
const exportBtn = document.getElementById('exportBtn');
const exportDisplayedBtn = document.getElementById('exportDisplayedBtn');
const exportHierarchyBtn = document.getElementById('exportHierarchyBtn');
const siteSearchInput = document.getElementById('siteSearchInput');
const siteSearchBtn = document.getElementById('siteSearchBtn');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const searchResultsDropdown = document.getElementById('searchResultsDropdown');
const toggleImportMenuBtn = document.getElementById('toggleImportMenuBtn');
const importMenuPopover = document.getElementById('importMenuPopover');
const importDataMenuBtn = document.getElementById('importDataMenuBtn');
const importSitesMenuBtn = document.getElementById('importSitesMenuBtn');
const importKmlMenuBtn = document.getElementById('importKmlMenuBtn');
const badgeFilter2G = document.getElementById('badgeFilter2G');
const badgeFilter2G3G = document.getElementById('badgeFilter2G3G');
const badgeFilter2G3G4G = document.getElementById('badgeFilter2G3G4G');
const badgeFilter2G3G4G5G = document.getElementById('badgeFilter2G3G4G5G');
const badgeFilterNC = document.getElementById('badgeFilterNC');
const toggleRulerBtn = document.getElementById('toggleRulerBtn');
const clearRulerBtn = document.getElementById('clearRulerBtn');
const toggleDrawToolBtn = document.getElementById('toggleDrawToolBtn');
const drawToolPopover = document.getElementById('drawToolPopover');
const drawToolPopoverHeader = document.getElementById('drawToolPopoverHeader');
const drawModeDotBtn = document.getElementById('drawModeDotBtn');
const drawModeLineBtn = document.getElementById('drawModeLineBtn');
const drawModeArrowBtn = document.getElementById('drawModeArrowBtn');
const drawModeRectangleBtn = document.getElementById('drawModeRectangleBtn');
const drawModeCircleBtn = document.getElementById('drawModeCircleBtn');
const drawStrokeColor = document.getElementById('drawStrokeColor');
const drawStrokeWidth = document.getElementById('drawStrokeWidth');
const drawStrokeOpacity = document.getElementById('drawStrokeOpacity');
const drawFillOpacity = document.getElementById('drawFillOpacity');
const drawDashedStroke = document.getElementById('drawDashedStroke');
const drawToolHint = document.getElementById('drawToolHint');
const stopDrawingBtn = document.getElementById('stopDrawingBtn');
const removeSelectedDrawingBtn = document.getElementById('removeSelectedDrawingBtn');
const clearDrawingsBtn = document.getElementById('clearDrawingsBtn');
const toggleTextToolBtn = document.getElementById('toggleTextToolBtn');
const textToolPopover = document.getElementById('textToolPopover');
const textToolPopoverHeader = document.getElementById('textToolPopoverHeader');
const textAnnotationInput = document.getElementById('textAnnotationInput');
const textAnnotationFont = document.getElementById('textAnnotationFont');
const textAnnotationSize = document.getElementById('textAnnotationSize');
const textAnnotationColor = document.getElementById('textAnnotationColor');
const textAnnotationOpacity = document.getElementById('textAnnotationOpacity');
const textAnnotationUseBackground = document.getElementById('textAnnotationUseBackground');
const textAnnotationBgColor = document.getElementById('textAnnotationBgColor');
const textAnnotationBgOpacity = document.getElementById('textAnnotationBgOpacity');
const placeTextAnnotationBtn = document.getElementById('placeTextAnnotationBtn');
const removeTextAnnotationBtn = document.getElementById('removeTextAnnotationBtn');
const clearTextAnnotationsBtn = document.getElementById('clearTextAnnotationsBtn');
const wikimapiaApiKeyInput = document.getElementById('wikimapiaApiKeyInput');
const saveWikimapiaKeyBtn = document.getElementById('saveWikimapiaKeyBtn');
const clearWikimapiaKeyBtn = document.getElementById('clearWikimapiaKeyBtn');
const wikimapiaKeyStatus = document.getElementById('wikimapiaKeyStatus');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const sidebar = document.querySelector('.sidebar');
const manualSiteName = document.getElementById('manualSiteName');
const manualLat = document.getElementById('manualLat');
const manualLng = document.getElementById('manualLng');
const addSiteBtn = document.getElementById('addSiteBtn');

const siteBddControls = {
    '2G': {
        row: document.getElementById('rowBdd2G'),
        toggle: toggleBdd2G,
        moveUp: document.getElementById('moveUpBdd2G'),
        moveDown: document.getElementById('moveDownBdd2G'),
        settingsToggle: document.getElementById('toggleSettingsBdd2G'),
        settingsPanel: document.getElementById('controlsBdd2G'),
        color: colorBdd2G,
        count: countBdd2G,
        showNames: document.getElementById('showNamesBdd2G'),
        siteSizeInput: document.getElementById('siteSizeInputBdd2G'),
        siteSizeValue: document.getElementById('siteSizeValueBdd2G'),
        siteOpacityInput: document.getElementById('siteOpacityInputBdd2G'),
        siteOpacityValue: document.getElementById('siteOpacityValueBdd2G'),
        sectorLengthInput: document.getElementById('sectorLengthInputBdd2G'),
        sectorLengthValue: document.getElementById('sectorLengthValueBdd2G'),
        sectorWidthInput: document.getElementById('sectorWidthInputBdd2G'),
        sectorWidthValue: document.getElementById('sectorWidthValueBdd2G'),
        sectorOpacityInput: document.getElementById('sectorOpacityInputBdd2G'),
        sectorOpacityValue: document.getElementById('sectorOpacityValueBdd2G'),
        labelTextColorInput: document.getElementById('labelTextColorBdd2G'),
        labelBackgroundColorInput: document.getElementById('labelBackgroundColorBdd2G'),
        labelBackgroundOpacityInput: document.getElementById('labelBackgroundOpacityInputBdd2G'),
        labelBackgroundOpacityValue: document.getElementById('labelBackgroundOpacityValueBdd2G')
    },
    '3G': {
        row: document.getElementById('rowBdd3G'),
        toggle: toggleBdd3G,
        moveUp: document.getElementById('moveUpBdd3G'),
        moveDown: document.getElementById('moveDownBdd3G'),
        settingsToggle: document.getElementById('toggleSettingsBdd3G'),
        settingsPanel: document.getElementById('controlsBdd3G'),
        color: colorBdd3G,
        count: countBdd3G,
        showNames: document.getElementById('showNamesBdd3G'),
        siteSizeInput: document.getElementById('siteSizeInputBdd3G'),
        siteSizeValue: document.getElementById('siteSizeValueBdd3G'),
        siteOpacityInput: document.getElementById('siteOpacityInputBdd3G'),
        siteOpacityValue: document.getElementById('siteOpacityValueBdd3G'),
        sectorLengthInput: document.getElementById('sectorLengthInputBdd3G'),
        sectorLengthValue: document.getElementById('sectorLengthValueBdd3G'),
        sectorWidthInput: document.getElementById('sectorWidthInputBdd3G'),
        sectorWidthValue: document.getElementById('sectorWidthValueBdd3G'),
        sectorOpacityInput: document.getElementById('sectorOpacityInputBdd3G'),
        sectorOpacityValue: document.getElementById('sectorOpacityValueBdd3G'),
        labelTextColorInput: document.getElementById('labelTextColorBdd3G'),
        labelBackgroundColorInput: document.getElementById('labelBackgroundColorBdd3G'),
        labelBackgroundOpacityInput: document.getElementById('labelBackgroundOpacityInputBdd3G'),
        labelBackgroundOpacityValue: document.getElementById('labelBackgroundOpacityValueBdd3G')
    },
    '4G': {
        row: document.getElementById('rowBdd4G'),
        toggle: toggleBdd4G,
        moveUp: document.getElementById('moveUpBdd4G'),
        moveDown: document.getElementById('moveDownBdd4G'),
        settingsToggle: document.getElementById('toggleSettingsBdd4G'),
        settingsPanel: document.getElementById('controlsBdd4G'),
        color: colorBdd4G,
        count: countBdd4G,
        showNames: document.getElementById('showNamesBdd4G'),
        siteSizeInput: document.getElementById('siteSizeInputBdd4G'),
        siteSizeValue: document.getElementById('siteSizeValueBdd4G'),
        siteOpacityInput: document.getElementById('siteOpacityInputBdd4G'),
        siteOpacityValue: document.getElementById('siteOpacityValueBdd4G'),
        sectorLengthInput: document.getElementById('sectorLengthInputBdd4G'),
        sectorLengthValue: document.getElementById('sectorLengthValueBdd4G'),
        sectorWidthInput: document.getElementById('sectorWidthInputBdd4G'),
        sectorWidthValue: document.getElementById('sectorWidthValueBdd4G'),
        sectorOpacityInput: document.getElementById('sectorOpacityInputBdd4G'),
        sectorOpacityValue: document.getElementById('sectorOpacityValueBdd4G'),
        labelTextColorInput: document.getElementById('labelTextColorBdd4G'),
        labelBackgroundColorInput: document.getElementById('labelBackgroundColorBdd4G'),
        labelBackgroundOpacityInput: document.getElementById('labelBackgroundOpacityInputBdd4G'),
        labelBackgroundOpacityValue: document.getElementById('labelBackgroundOpacityValueBdd4G')
    }
};

const networkBadgeControls = {
    '2G': badgeFilter2G,
    '2G/3G': badgeFilter2G3G,
    '2G/3G/4G': badgeFilter2G3G4G,
    '2G/3G/4G/5G': badgeFilter2G3G4G5G,
    NC: badgeFilterNC
};


// --- Load Data ---
async function loadGeoData() {
    updateStatus(true, 'Loading map data...');
    state.geoDataLoaded = false;
    try {
        const timestamp = new Date().getTime();
        const [regionsRes, provincesRes, communesRes, emergencyRes, drMappingRes, drsRes, lieuxRes, inhabitedAreasRes] = await Promise.all([
            fetch(`./data/regions.json?v=${timestamp}`),
            fetch(`./data/provinces.json?v=${timestamp}`),
            fetch(`./data/communes.json?v=${timestamp}`),
            fetch(`./data/emergency_numbers.json?v=${timestamp}`),
            fetch(`./data/province_to_dr.json?v=${timestamp}`),
            fetch(`./data/drs.json?v=${timestamp}`),
            fetch(`./data/lieux_places.json?v=${timestamp}`),
            fetch(`./data/zones_habitees_areas.json?v=${timestamp}`)
        ]);

        state.layers.regions = await regionsRes.json();
        state.layers.provinces = await provincesRes.json();
        state.layers.communes = await communesRes.json();
        state.emergencyData = await emergencyRes.json();
        const drRows = await drMappingRes.json();
        const lieuxPayload = await lieuxRes.json();
        state.referencePlaces = lieuxPayload.places || [];
        state.referencePlaceGrid = buildReferencePlaceGrid(state.referencePlaces);
        state.referencePlaceNameIndex = buildReferencePlaceNameIndex(state.referencePlaces);
        state.referencePlaceAdminCache.clear();
        const inhabitedAreasPayload = await inhabitedAreasRes.json();
        state.inhabitedAreas = (inhabitedAreasPayload.areas || []).map((area) => ({
            ...area,
            feature: {
                type: 'Feature',
                properties: {
                    Name: area.name,
                    fclass: area.fclass
                },
                geometry: area.geometry
            }
        }));

        // Build emergency index
        state.emergencyDataMap.clear();
        const norm = (str) => String(str || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        state.emergencyData.forEach(row => {
            const rowCommune = row['Commune SS'] || row['Commune'] || row['COMMUNE'];
            // const rowProvince = row['Province'] || row['PROVINCE'];
            if (rowCommune) {
                state.emergencyDataMap.set(norm(rowCommune), row);
            }
        });

        console.log('Loaded emergency data:', state.emergencyData.length, 'rows. Indexed:', state.emergencyDataMap.size);

        // Pre-calc BBoxes for fast spatial lookup
        const calcBBoxes = (fc) => {
            fc.features.forEach(f => {
                f.bbox = turf.bbox(f);
            });
        };
        calcBBoxes(state.layers.regions);
        calcBBoxes(state.layers.provinces);
        calcBBoxes(state.layers.communes);
        state.spatialIndexes.regions = buildSpatialFeatureIndex(state.layers.regions.features);
        state.spatialIndexes.provinces = buildSpatialFeatureIndex(state.layers.provinces.features);
        state.spatialIndexes.communes = buildSpatialFeatureIndex(state.layers.communes.features);


        // --- Region Coloring ---
        // distinct colors for 12 regions
        const distinctColors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD', '#D4A5A5',
            '#9B59B6', '#3498DB', '#E67E22', '#2ECC71', '#F1C40F', '#E74C3C'
        ];

        // Create mapping: RegionName -> Color
        // stored in state for legend usage
        const regionColorMap = new Map();

        state.layers.regions.features.forEach((feature, index) => {
            const props = feature.properties;
            const name = props.Nom_Region || props.Nom_region || props.NAME || 'Region ' + (index + 1);
            if (!regionColorMap.has(name)) {
                const color = distinctColors[regionColorMap.size % distinctColors.length];
                regionColorMap.set(name, color);
                state.regionColors[name] = color;
            }
        });

        // Remove old Leaflet Legend if present
        // (No persistent ref kept, but we are using custom #drLegend now)





        // --- DR Aggregation Logic (Optimized) ---
        try {
            // Load pre-generated DRs
            state.layers.drs = await drsRes.json();
            calcBBoxes(state.layers.drs);
            state.spatialIndexes.drs = buildSpatialFeatureIndex(state.layers.drs.features);

            const drMap = new Map();
            drRows.forEach(row => {
                const drName = row['DR'];
                const provinceName = row['Province'];
                if (drName && provinceName) {
                    if (!drMap.has(drName)) drMap.set(drName, []);
                    drMap.get(drName).push(provinceName);
                }
            });

            // Store in state for UI filtering
            drMap.forEach((v, k) => state.drToProvinces[k] = v);

            // Set all DRs to hidden by default (user request)
            // if (state.drToProvinces) {
            //     Object.keys(state.drToProvinces).forEach(drName => {
            //         hierarchy.visible.drs.add(drName);
            //     });
            //     hierarchy.visible.drs.add('DRR'); // Exceptions target
            // }

            // Assign Colors to DRs
            const palette = [
                '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD', '#D4A5A5',
                '#9B59B6', '#3498DB', '#E67E22', '#2ECC71', '#F1C40F', '#E74C3C'
            ];

            state.layers.drs.features.forEach((f, i) => {
                const name = f.properties.NAME;
                state.drColors[name] = palette[i % palette.length];
            });

            // Update DR Layer Style function to use assigned colors
            state.mapLayerGroups.drs.clearLayers();
            L.geoJSON(state.layers.drs, {
                style: (feature) => ({
                    color: state.drColors[feature.properties.NAME] || '#8b5cf6',
                    weight: 2,
                    fillOpacity: 0.4,
                    dashArray: '5, 5'
                }),
                onEachFeature: (feature, layer) => {
                    layer.bindPopup(`<b>${feature.properties.NAME}</b>`);
                }
            }).addTo(state.mapLayerGroups.drs);

            console.log(`Loaded ${state.layers.drs.features.length} DR regions.`);

        } catch (e) {
            console.error("Error processing DR mapping:", e);
            state.spatialIndexes.drs = null;
        }

        updateStatus(true, 'Preparing analysis engine...');
        resetAnalysisWorker();
        await ensureAnalysisWorker();

        updateStatus(false);

        // Initialize Visibility Sets
        // Regions: Hidden by default (user request)
        // state.layers.regions.features.forEach(f => {
        //     const name = f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME;
        //     if (name) hierarchy.visible.regions.add(name);
        // });

        // DRs: All visible by default (handled in DR logic, but good to confirm)
        // Provinces/Communes: Hidden by default (sets empty)

        // Initial Hierarchy Render
        renderRegions();
        renderDRs();
        renderProvinces();
        renderCommunes();

        // Initial Map Layer Render
        updateMapVisibility('region');
        updateMapVisibility('dr');
        updateMapVisibility('province');
        updateMapVisibility('commune');
        state.geoDataLoaded = true;
        await loadBuiltInSiteBddData();

        // updateLegend(); // Handled by toggles? No, remove updateLegend call since toggles are removed or different
    } catch (err) {
        console.error(err);
        updateStatus(false);
        state.geoDataLoaded = false;
        alert('Failed to load map data. Please ensuring conversion script ran.');
    }
}

function renderGeoJson(data, group, style) {
    L.geoJSON(data, {
        style: style,
        onEachFeature: (feature, layer) => {
            // Try to find a name property
            const props = feature.properties;
            const name = props.Nom_Region || props.Nom_Provin || props.Nom_Commun || props.Nom_region || props.Nom_provin || props.Nom_commun || props.NAME || 'Unknown';
            layer.bindPopup(name);
        }
    }).addTo(group);
}

// --- File Handling ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) processExcel(file);
});
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processExcel(file);
});

toggleImportMenuBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!importMenuPopover) return;
    if (importMenuPopover.hasAttribute('hidden')) {
        openImportMenuPopover();
    } else {
        closeImportMenuPopover();
    }
});

importMenuPopover?.addEventListener('click', (event) => {
    event.stopPropagation();
});

importDataMenuBtn?.addEventListener('click', () => {
    fileInput?.click();
    closeImportMenuPopover();
});

importSitesMenuBtn?.addEventListener('click', () => {
    sitesFileInput?.click();
    closeImportMenuPopover();
});

importKmlMenuBtn?.addEventListener('click', () => {
    kmlSitesFileInput?.click();
    closeImportMenuPopover();
});

if (importSitesBtn) {
    importSitesBtn.addEventListener('click', () => {
        sitesFileInput?.click();
    });
}

if (sitesFileInput) {
    sitesFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            processSitesWorkbook(file);
        }
        e.target.value = '';
    });
}

if (clearSitesBtn) {
    clearSitesBtn.addEventListener('click', () => {
        resetSiteBddState();
    });
}

clearSitesBtnCompact?.addEventListener('click', () => {
    resetSiteBddState();
});

if (importKmlSitesBtn) {
    importKmlSitesBtn.addEventListener('click', () => {
        kmlSitesFileInput?.click();
    });
}

if (kmlSitesFileInput) {
    kmlSitesFileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files?.length) {
            processKmlSiteFiles(files);
        }
        event.target.value = '';
    });
}

if (clearKmlSitesBtn) {
    clearKmlSitesBtn.addEventListener('click', () => {
        resetCustomSiteOverlays();
    });
}

clearKmlSitesBtnCompact?.addEventListener('click', () => {
    resetCustomSiteOverlays();
});

bindSectionCollapse(toggleOverlayLayersBtn, overlayLayersContent, false);
bindSectionCollapse(toggleImportedOverlaysBtn, importedOverlaysContent, false);
bindSectionCollapse(toggleHierarchyLayersBtn, hierarchyLayersContent, false);
bindSectionCollapse(toggleFiltersBtn, filtersContent, false);

async function processExcel(file) {
    if (!areGeoLayersReady()) {
        alert('Map layers are still loading. Please wait a moment, then import the Excel file again.');
        return;
    }

    updateStatus(true, 'Reading Excel file...');
    importSummaryText.textContent = '';

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const [{ parseWorkbookPoints }, XLSX] = await Promise.all([
                loadCoordinateNormalizerModule(),
                loadXlsxModule()
            ]);
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const { points, summary } = parseWorkbookPoints(workbook);

            if (points.length === 0) {
                throw new Error('No valid coordinates were found after normalization.');
            }

            state.points = points;
            state.importSummary = summary;
            state.localityReferenceOverrides.clear();
            state.activePointId = null;

            const summaryParts = [
                `${summary.plottedPoints} points plotted`,
                `${summary.flaggedRows} flagged`,
                `${summary.skippedRows} skipped`
            ];
            const sourceLabel = summary.sourceType === 'anrt_localities'
                ? 'ANRT workbook normalized automatically.'
                : 'Workbook normalized automatically.';
            importSummaryText.textContent = `${sourceLabel} ${summaryParts.join(' • ')}`;

            updateStatus(true, `Processing ${state.points.length} points...`);

            // Delay to allow UI to update
            setTimeout(() => analyzePoints(), 100);

        } catch (err) {
            console.error(err);
            alert('Error parsing Excel: ' + err.message);
            updateStatus(false);
        }
    };
    reader.readAsArrayBuffer(file);
}



// --- Helpers ---
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hexToRgba(hex, alpha = 1) {
    const sanitized = String(hex || '').replace('#', '');
    const normalized = sanitized.length === 3
        ? sanitized.split('').map((char) => char + char).join('')
        : sanitized;

    const red = parseInt(normalized.slice(0, 2), 16);
    const green = parseInt(normalized.slice(2, 4), 16);
    const blue = parseInt(normalized.slice(4, 6), 16);

    if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
        return `rgba(239, 68, 68, ${alpha})`;
    }

    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function appendCell(row, value, { className = '', title = '', colSpan = 1 } = {}) {
    const cell = document.createElement('td');
    cell.textContent = String(value ?? '');
    if (className) {
        cell.className = className;
    }
    if (title) {
        cell.title = title;
    }
    if (colSpan > 1) {
        cell.colSpan = colSpan;
    }
    row.appendChild(cell);
    return cell;
}

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

function createEmptySiteBddState() {
    return {
        imported: false,
        fileName: '',
        legendName: 'Sites IAM',
        globalSectorLengthScale: 100,
        mode: 'sites',
        bounds: null,
        layerOrder: [...SITE_BDD_TECH_ORDER],
        datasets: {
            '2G': createEmptySiteBddDataset('2G'),
            '3G': createEmptySiteBddDataset('3G'),
            '4G': createEmptySiteBddDataset('4G')
        }
    };
}

function createCustomSiteOverlay(fileName, points, index = state.customSiteOverlays.length) {
    const color = CUSTOM_SITE_OVERLAY_COLORS[index % CUSTOM_SITE_OVERLAY_COLORS.length];
    const label = fileName.replace(/\.(kml|kmz)$/i, '');
    return {
        id: `kml-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        fileName,
        label,
        legendName: label,
        visible: true,
        settingsOpen: false,
        showSiteNames: false,
        color,
        settings: {
            siteRadius: 7,
            siteOpacity: 0.8
        },
        points,
        pointGrid: buildSiteBddGrid(points)
    };
}

function formatSiteBddSettingValue(key, value) {
    switch (key) {
        case 'siteRadius':
            return `${Math.round(value)} px`;
        case 'siteOpacity':
        case 'sectorOpacity':
            return `${Math.round(value * 100)}%`;
        case 'sectorLengthKm':
            return `${Math.round(value * 1000)} m`;
        case 'sectorHalfAngle':
            return `${Math.round(value * 2)}°`;
        case 'labelBackgroundOpacity':
            return `${Math.round(value * 100)}%`;
        default:
            return String(value);
    }
}

function updateSiteBddRenderControlLabels(tech, settings = state.siteBdd.datasets[tech]?.settings) {
    const controls = siteBddControls[tech];
    if (!controls || !settings) return;

    if (controls.siteSizeValue) {
        controls.siteSizeValue.textContent = formatSiteBddSettingValue('siteRadius', settings.siteRadius);
    }
    if (controls.siteOpacityValue) {
        controls.siteOpacityValue.textContent = formatSiteBddSettingValue('siteOpacity', settings.siteOpacity);
    }
    if (controls.sectorLengthValue) {
        controls.sectorLengthValue.textContent = formatSiteBddSettingValue('sectorLengthKm', settings.sectorLengthKm);
    }
    if (controls.sectorWidthValue) {
        controls.sectorWidthValue.textContent = formatSiteBddSettingValue('sectorHalfAngle', settings.sectorHalfAngle);
    }
    if (controls.sectorOpacityValue) {
        controls.sectorOpacityValue.textContent = formatSiteBddSettingValue('sectorOpacity', settings.sectorOpacity);
    }
    if (controls.labelBackgroundOpacityValue) {
        controls.labelBackgroundOpacityValue.textContent = formatSiteBddSettingValue('labelBackgroundOpacity', settings.labelBackgroundOpacity);
    }
}

function updateGlobalSectorLengthControl() {
    if (globalSectorLengthScaleInput) {
        globalSectorLengthScaleInput.value = String(state.siteBdd.globalSectorLengthScale || 100);
    }
    if (globalSectorLengthScaleValue) {
        globalSectorLengthScaleValue.textContent = `${Math.round(state.siteBdd.globalSectorLengthScale || 100)}%`;
    }
}

function applyGlobalSectorLengthScale(nextScale) {
    const previousScale = state.siteBdd.globalSectorLengthScale || 100;
    const safeNextScale = Math.max(10, Math.min(300, Number(nextScale) || 100));
    const ratio = safeNextScale / previousScale;

    Object.values(state.siteBdd.datasets).forEach((dataset) => {
        const nextLengthKm = dataset.settings.sectorLengthKm * ratio;
        dataset.settings.sectorLengthKm = Math.max(0.01, Math.min(3, roundTo(nextLengthKm, 3)));
    });

    state.siteBdd.globalSectorLengthScale = safeNextScale;
}

function getSiteBddRenderOrder() {
    const order = state.siteBdd.layerOrder || SITE_BDD_TECH_ORDER;
    return order.filter((tech) => state.siteBdd.datasets[tech]);
}

function moveSiteBddLayer(tech, direction) {
    const order = [...getSiteBddRenderOrder()];
    const currentIndex = order.indexOf(tech);
    if (currentIndex === -1) return;

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= order.length) return;

    [order[currentIndex], order[nextIndex]] = [order[nextIndex], order[currentIndex]];
    state.siteBdd.layerOrder = order;
    updateSiteBddControls();
    renderSiteBddLayers();
}

function getSiteBddGridKey(lng, lat, cellSize = SITE_BDD_GRID_CELL_SIZE) {
    const x = Math.floor(lng / cellSize);
    const y = Math.floor(lat / cellSize);
    return `${x}:${y}`;
}

function buildSiteBddGrid(items, cellSize = SITE_BDD_GRID_CELL_SIZE) {
    const grid = new Map();
    items.forEach((item) => {
        const key = getSiteBddGridKey(item.lng, item.lat, cellSize);
        if (!grid.has(key)) {
            grid.set(key, []);
        }
        grid.get(key).push(item);
    });
    return grid;
}

function buildSiteBddStateFromPayload(payload, options = {}) {
    const nextState = createEmptySiteBddState();
    const previousState = options.preserveStateFrom || state.siteBdd;
    nextState.legendName = previousState.legendName || 'Sites IAM';
    nextState.globalSectorLengthScale = previousState.globalSectorLengthScale || 100;
    nextState.mode = previousState.mode;
    nextState.layerOrder = [...(previousState.layerOrder || SITE_BDD_TECH_ORDER)];
    const bounds = L.latLngBounds([]);

    Object.entries(SITE_BDD_CONFIG).forEach(([tech]) => {
        const previousDataset = previousState.datasets[tech];
        const incomingDataset = payload?.datasets?.[tech] || {};
        const sites = Array.isArray(incomingDataset.sites) ? incomingDataset.sites : [];
        const sectors = Array.isArray(incomingDataset.sectors) ? incomingDataset.sectors : [];

        nextState.datasets[tech].color = previousDataset.color;
        nextState.datasets[tech].visible = previousDataset.visible;
        nextState.datasets[tech].settingsOpen = previousDataset.settingsOpen;
        nextState.datasets[tech].showSiteNames = previousDataset.showSiteNames;
        nextState.datasets[tech].settings = { ...previousDataset.settings };
        nextState.datasets[tech].sites = sites;
        nextState.datasets[tech].sectors = sectors;
        nextState.datasets[tech].siteGrid = buildSiteBddGrid(sites);
        nextState.datasets[tech].sectorGrid = buildSiteBddGrid(sectors);

        sites.forEach((site) => {
            if (Number.isFinite(site.lat) && Number.isFinite(site.lng)) {
                bounds.extend([site.lat, site.lng]);
            }
        });
    });

    nextState.imported = true;
    nextState.fileName = payload?.fileName || options.fileName || 'Built-in Sites BDD';
    nextState.bounds = bounds.isValid() ? bounds : null;
    return nextState;
}

function getSiteBddSummaryParts(siteBddState = state.siteBdd) {
    return Object.keys(SITE_BDD_CONFIG).map((tech) => {
        const dataset = siteBddState.datasets[tech];
        return `${tech}: ${dataset.sites.length.toLocaleString()} sites / ${dataset.sectors.length.toLocaleString()} sectors`;
    });
}

function updateSiteBddSummaryText(message) {
    if (sitesImportSummaryText) {
        sitesImportSummaryText.textContent = message;
    }
}

function createSiteBddPayloadFromWorkbook(XLSX, workbook, fileName = '') {
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
            const siteKey = `${siteName}|${roundTo(lat, 6)}|${roundTo(lng, 6)}`;

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

function collectSiteBddItemsInBounds(grid, bounds, cellSize = SITE_BDD_GRID_CELL_SIZE) {
    if (!grid || !bounds) return [];

    const items = [];
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const startX = Math.floor(west / cellSize);
    const endX = Math.floor(east / cellSize);
    const startY = Math.floor(south / cellSize);
    const endY = Math.floor(north / cellSize);

    for (let x = startX; x <= endX; x += 1) {
        for (let y = startY; y <= endY; y += 1) {
            const bucket = grid.get(`${x}:${y}`);
            if (bucket) {
                items.push(...bucket);
            }
        }
    }

    return items;
}

async function inflateZipEntry(compressedBytes, compressionMethod) {
    if (compressionMethod === 0) {
        return compressedBytes;
    }

    if (compressionMethod !== 8) {
        throw new Error(`Unsupported KMZ compression method: ${compressionMethod}`);
    }

    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser does not support KMZ decompression.');
    }

    const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const inflatedBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(inflatedBuffer);
}

async function extractKmlTextFromKmz(file) {
    const arrayBuffer = await file.arrayBuffer();
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const endSignature = 0x06054b50;
    let endOffset = -1;

    for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
        if (view.getUint32(offset, true) === endSignature) {
            endOffset = offset;
            break;
        }
    }

    if (endOffset === -1) {
        throw new Error('Invalid KMZ: central directory not found.');
    }

    const entryCount = view.getUint16(endOffset + 10, true);
    const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
    let offset = centralDirectoryOffset;
    const centralSignature = 0x02014b50;
    const localSignature = 0x04034b50;
    const decoder = new TextDecoder('utf-8');

    for (let index = 0; index < entryCount; index += 1) {
        if (view.getUint32(offset, true) !== centralSignature) {
            throw new Error('Invalid KMZ: malformed central directory entry.');
        }

        const compressionMethod = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const fileNameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localHeaderOffset = view.getUint32(offset + 42, true);
        const entryName = decoder.decode(bytes.slice(offset + 46, offset + 46 + fileNameLength));

        offset += 46 + fileNameLength + extraLength + commentLength;

        if (!/\.kml$/i.test(entryName)) {
            continue;
        }

        if (view.getUint32(localHeaderOffset, true) !== localSignature) {
            throw new Error('Invalid KMZ: malformed local file header.');
        }

        const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
        const fileDataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
        const compressedBytes = bytes.slice(fileDataOffset, fileDataOffset + compressedSize);
        const kmlBytes = await inflateZipEntry(compressedBytes, compressionMethod);
        return decoder.decode(kmlBytes);
    }

    throw new Error('No KML file found inside KMZ.');
}

function parseCoordinatesText(value) {
    const [lngRaw, latRaw] = String(value || '').trim().split(',');
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }
    return { lat, lng };
}

function parseKmlSitePoints(kmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(kmlText, 'application/xml');
    const parseError = xml.querySelector('parsererror');
    if (parseError) {
        throw new Error('Invalid KML document.');
    }

    const placemarks = [...xml.getElementsByTagNameNS('*', 'Placemark')];
    const points = [];

    placemarks.forEach((placemark, index) => {
        const pointNode = placemark.getElementsByTagNameNS('*', 'Point')[0];
        if (!pointNode) return;

        const coordinatesNode = pointNode.getElementsByTagNameNS('*', 'coordinates')[0];
        const coords = parseCoordinatesText(coordinatesNode?.textContent);
        if (!coords) return;

        const nameNode = placemark.getElementsByTagNameNS('*', 'name')[0];
        const descriptionNode = placemark.getElementsByTagNameNS('*', 'description')[0];
        const name = String(nameNode?.textContent || `Placemark ${index + 1}`).trim();

        points.push({
            id: `kml-point-${index + 1}`,
            name,
            description: String(descriptionNode?.textContent || '').trim(),
            lat: coords.lat,
            lng: coords.lng
        });
    });

    return points;
}

function buildCustomSitePopupHtml(point, overlay) {
    return `
      <b>${escapeHtml(point.name || overlay.label)}</b><br>
      Overlay: ${escapeHtml(overlay.label)}<br>
      Lat/Lon: ${roundTo(point.lat, 6)}, ${roundTo(point.lng, 6)}<br>
      ${point.description ? `<div style="margin-top:6px">${escapeHtml(point.description)}</div>` : ''}
    `;
}

function createCustomSiteOverlayLayer(point, overlay) {
    const layer = L.circleMarker([point.lat, point.lng], {
        renderer: siteBddCanvasRenderer,
        radius: overlay.settings.siteRadius,
        weight: Math.max(1, roundTo(overlay.settings.siteRadius * 0.3, 1)),
        color: overlay.color,
        opacity: overlay.settings.siteOpacity,
        fillColor: overlay.color,
        fillOpacity: overlay.settings.siteOpacity
    }).bindPopup(buildCustomSitePopupHtml(point, overlay));

    if (overlay.showSiteNames) {
        attachSiteBddNameTooltip(layer, { siteName: point.name }, overlay.color, 'top');
    }

    return layer;
}

function computeDestinationPoint(lat, lng, bearingDeg, distanceKm) {
    const bearing = (bearingDeg * Math.PI) / 180;
    const distanceRatio = distanceKm / 6371;
    const latRad = (lat * Math.PI) / 180;
    const lngRad = (lng * Math.PI) / 180;

    const destLat = Math.asin(
        Math.sin(latRad) * Math.cos(distanceRatio) +
        Math.cos(latRad) * Math.sin(distanceRatio) * Math.cos(bearing)
    );

    const destLng = lngRad + Math.atan2(
        Math.sin(bearing) * Math.sin(distanceRatio) * Math.cos(latRad),
        Math.cos(distanceRatio) - Math.sin(latRad) * Math.sin(destLat)
    );

    return {
        lat: (destLat * 180) / Math.PI,
        lng: (destLng * 180) / Math.PI
    };
}

function createSectorTriangleCoords(lat, lng, azimuth, settings) {
    if (!Number.isFinite(azimuth)) {
        return null;
    }

    const left = computeDestinationPoint(
        lat,
        lng,
        azimuth - settings.sectorHalfAngle,
        settings.sectorLengthKm
    );
    const right = computeDestinationPoint(
        lat,
        lng,
        azimuth + settings.sectorHalfAngle,
        settings.sectorLengthKm
    );
    return [
        [lat, lng],
        [left.lat, left.lng],
        [right.lat, right.lng]
    ];
}

function formatSiteBddPopup(item, tech, mode) {
    if (mode === 'sectors') {
        return `
            <b>${escapeHtml(item.sectorName || item.siteName || SITE_BDD_CONFIG[tech].label)}</b><br>
            Tech: ${escapeHtml(tech)}<br>
            Site: ${escapeHtml(item.siteName || '-') }<br>
            Azimut: ${Number.isFinite(item.azimuth) ? Math.round(item.azimuth) : 'N/A'}<br>
            Lat/Lon: ${roundTo(item.lat, 6)}, ${roundTo(item.lng, 6)}
        `;
    }

    return `
        <b>${escapeHtml(item.siteName || SITE_BDD_CONFIG[tech].label)}</b><br>
        Tech: ${escapeHtml(tech)}<br>
        Sectors: ${item.sectorCount || 0}<br>
        Lat/Lon: ${roundTo(item.lat, 6)}, ${roundTo(item.lng, 6)}
    `;
}

function createSiteBddSiteLayer(item, tech, color, settings) {
    return L.circleMarker([item.lat, item.lng], {
        renderer: siteBddCanvasRenderer,
        radius: settings.siteRadius,
        weight: Math.max(1, roundTo(settings.siteRadius * 0.35, 1)),
        color,
        opacity: settings.siteOpacity,
        fillColor: color,
        fillOpacity: settings.siteOpacity
    }).bindPopup(formatSiteBddPopup(item, tech, 'sites'));
}

function createSiteBddSectorLayer(item, tech, color, settings) {
    const triangleCoords = createSectorTriangleCoords(item.lat, item.lng, item.azimuth, settings);
    if (!triangleCoords) {
        return createSiteBddSiteLayer(item, tech, color, settings);
    }

    return L.polygon(triangleCoords, {
        renderer: siteBddCanvasRenderer,
        color,
        weight: 1.15,
        opacity: Math.min(1, settings.sectorOpacity + 0.35),
        fillColor: color,
        fillOpacity: settings.sectorOpacity,
        lineJoin: 'round'
    }).bindPopup(formatSiteBddPopup(item, tech, 'sectors'));
}

function attachSiteBddNameTooltip(layer, item, settingsOrColor, direction = 'top') {
    if (!item?.siteName) {
        return layer;
    }

    const labelSettings = typeof settingsOrColor === 'string'
        ? {
            textColor: settingsOrColor,
            backgroundColor: '#020617',
            backgroundOpacity: 0.82
        }
        : {
            textColor: settingsOrColor?.labelTextColor || '#ffffff',
            backgroundColor: settingsOrColor?.labelBackgroundColor || '#020617',
            backgroundOpacity: settingsOrColor?.labelBackgroundOpacity ?? 0.82
        };

    layer.bindTooltip(
        `<span class="site-bdd-name-tooltip__text" style="--label-color: ${escapeHtml(labelSettings.textColor)}; --label-background: ${escapeHtml(hexToRgba(labelSettings.backgroundColor, labelSettings.backgroundOpacity))}">${escapeHtml(item.siteName)}</span>`,
        {
            permanent: true,
            direction,
            offset: direction === 'top' ? [10, -10] : [10, 0],
            opacity: 1,
            className: 'site-bdd-name-tooltip'
        }
    );

    return layer;
}

function createSiteBddLabelAnchor(item) {
    return L.marker([item.lat, item.lng], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
            className: 'site-bdd-label-anchor',
            html: '',
            iconSize: [1, 1],
            iconAnchor: [0, 0]
        })
    });
}

function updateSiteBddControls() {
    bddModeSites.checked = state.siteBdd.mode === 'sites';
    bddModeSectors.checked = state.siteBdd.mode === 'sectors';
    updateGlobalSectorLengthControl();
    const renderOrder = getSiteBddRenderOrder();

    renderOrder.forEach((tech, index) => {
        const dataset = state.siteBdd.datasets[tech];
        const controls = siteBddControls[tech];
        if (!controls) return;

        if (bddLayerGrid && controls.row) {
            bddLayerGrid.appendChild(controls.row);
        }
        controls.toggle.checked = dataset.visible;
        controls.color.value = dataset.color;
        controls.moveUp.disabled = index === 0;
        controls.moveDown.disabled = index === renderOrder.length - 1;
        controls.settingsToggle.setAttribute('aria-expanded', String(dataset.settingsOpen));
        controls.settingsToggle.textContent = dataset.settingsOpen ? '✕' : '⚙';
        controls.settingsPanel.hidden = !dataset.settingsOpen;
        controls.showNames.checked = dataset.showSiteNames;
        if (siteBddLegendName) {
            siteBddLegendName.value = state.siteBdd.legendName || 'Sites IAM';
        }
        controls.siteSizeInput.value = String(dataset.settings.siteRadius);
        controls.siteOpacityInput.value = String(dataset.settings.siteOpacity);
        controls.sectorLengthInput.value = String(Math.round(dataset.settings.sectorLengthKm * 1000));
        controls.sectorWidthInput.value = String(dataset.settings.sectorHalfAngle * 2);
        controls.sectorOpacityInput.value = String(dataset.settings.sectorOpacity);
        if (controls.labelTextColorInput) controls.labelTextColorInput.value = dataset.settings.labelTextColor;
        if (controls.labelBackgroundColorInput) controls.labelBackgroundColorInput.value = dataset.settings.labelBackgroundColor;
        if (controls.labelBackgroundOpacityInput) controls.labelBackgroundOpacityInput.value = String(dataset.settings.labelBackgroundOpacity);
        updateSiteBddRenderControlLabels(tech, dataset.settings);
        controls.count.textContent = state.siteBdd.imported
            ? `${dataset.sites.length.toLocaleString()} sites / ${dataset.sectors.length.toLocaleString()} sectors`
            : '0 sites';
    });
}

function updateSiteBddHint(message = '') {
    if (!sitesRenderHint) return;
    sitesRenderHint.textContent = message;
}

function renderSiteBddLayers() {
    const mode = state.siteBdd.mode;
    const bounds = map.getBounds().pad(0.15);
    const visibleLabels = [];
    let limited = false;
    const renderOrder = getSiteBddRenderOrder();
    const drawOrder = [...renderOrder].reverse();

    drawOrder.forEach((tech) => {
        const dataset = state.siteBdd.datasets[tech];
        const group = state.mapLayerGroups.siteBdds[tech];
        group.clearLayers();

        if (!state.siteBdd.imported || !dataset.visible) {
            return;
        }

        if (mode === 'sectors' && map.getZoom() < SITE_BDD_SECTOR_MIN_ZOOM) {
            return;
        }

        const items = collectSiteBddItemsInBounds(
            mode === 'sites' ? dataset.siteGrid : dataset.sectorGrid,
            bounds
        );

        const renderItems = mode === 'sectors' && items.length > SITE_BDD_SECTOR_RENDER_LIMIT
            ? items.slice(0, SITE_BDD_SECTOR_RENDER_LIMIT)
            : items;

        if (mode === 'sectors' && renderItems.length < items.length) {
            limited = true;
        }

        renderItems.forEach((item) => {
            const layer = mode === 'sites'
                ? createSiteBddSiteLayer(item, tech, dataset.color, dataset.settings)
                : createSiteBddSectorLayer(item, tech, dataset.color, dataset.settings);
            if (dataset.showSiteNames && mode === 'sites') {
                attachSiteBddNameTooltip(layer, item, dataset.settings, mode === 'sites' ? 'top' : 'center');
            }
            layer.addTo(group);
            if (layer.bringToFront) {
                layer.bringToFront();
            }
        });

        if (dataset.showSiteNames && mode === 'sectors') {
            const labelItems = collectSiteBddItemsInBounds(dataset.siteGrid, bounds);
            labelItems.forEach((item) => {
                const labelAnchor = createSiteBddLabelAnchor(item);
                attachSiteBddNameTooltip(labelAnchor, item, dataset.settings, 'top');
                labelAnchor.addTo(group);
            });
        }
    });

    renderOrder.forEach((tech, orderIndex) => {
        const dataset = state.siteBdd.datasets[tech];
        if (!state.siteBdd.imported || !dataset.visible) {
            return;
        }
        if (mode === 'sectors' && map.getZoom() < SITE_BDD_SECTOR_MIN_ZOOM) {
            return;
        }
        const visibleCount = collectSiteBddItemsInBounds(
            mode === 'sites' ? dataset.siteGrid : dataset.sectorGrid,
            bounds
        ).length;
        visibleLabels.push(`${orderIndex + 1}. ${dataset.label}: ${visibleCount.toLocaleString()} ${mode === 'sites' ? 'visible sites' : 'visible sectors'}`);
    });

    if (!state.siteBdd.imported) {
        updateSiteBddHint('');
        updateLegend();
        return;
    }

    if (mode === 'sectors' && map.getZoom() < SITE_BDD_SECTOR_MIN_ZOOM) {
        updateSiteBddHint(`Zoom in to level ${SITE_BDD_SECTOR_MIN_ZOOM} or more to display sectors.`);
        updateLegend();
        return;
    }

    const summary = visibleLabels.join(' • ');
    const suffix = limited ? ' • zoom in further to render all visible sectors.' : '';
    updateSiteBddHint(summary ? `${summary}${suffix}` : '');
    updateLegend();
}

function updateCustomSiteOverlaySummary() {
    if (!kmlSitesSummaryText) return;

    if (!state.customSiteOverlays.length) {
        kmlSitesSummaryText.textContent = 'No KML/KMZ site overlays imported yet.';
        return;
    }

    const summary = state.customSiteOverlays
        .map((overlay) => `${overlay.label}: ${overlay.points.length.toLocaleString()} sites`)
        .join(' • ');
    kmlSitesSummaryText.textContent = `${state.customSiteOverlays.length} overlay(s) imported. ${summary}`;
}

function renderCustomSiteOverlayControls() {
    if (!kmlSiteOverlayList) return;
    kmlSiteOverlayList.innerHTML = '';

    state.customSiteOverlays.forEach((overlay) => {
        const row = document.createElement('div');
        row.className = 'bdd-layer-row kml-site-row';

        const visibility = document.createElement('label');
        visibility.className = 'bdd-visibility';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = overlay.visible;
        checkbox.addEventListener('change', (event) => {
            overlay.visible = event.target.checked;
            renderCustomSiteOverlays();
        });
        const title = document.createElement('span');
        title.textContent = overlay.label;
        visibility.appendChild(checkbox);
        visibility.appendChild(title);

        const actions = document.createElement('div');
        actions.className = 'kml-site-actions';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn icon-only small kml-site-remove-btn';
        removeBtn.title = `Remove ${overlay.label}`;
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            state.customSiteOverlays = state.customSiteOverlays.filter((item) => item.id !== overlay.id);
            updateCustomSiteOverlaySummary();
            renderCustomSiteOverlayControls();
            renderCustomSiteOverlays();
        });
        actions.appendChild(removeBtn);

        const settingsToggle = document.createElement('button');
        settingsToggle.type = 'button';
        settingsToggle.className = 'btn icon-only small bdd-settings-toggle';
        settingsToggle.title = `Toggle ${overlay.label} settings`;
        settingsToggle.textContent = overlay.settingsOpen ? '✕' : '⚙';
        settingsToggle.setAttribute('aria-expanded', String(overlay.settingsOpen));

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'bdd-color-input';
        colorInput.value = overlay.color;
        colorInput.addEventListener('input', (event) => {
            overlay.color = event.target.value;
            renderCustomSiteOverlays();
        });

        const count = document.createElement('span');
        count.className = 'bdd-count';
        count.textContent = `${overlay.points.length.toLocaleString()} sites`;

        const controls = document.createElement('div');
        controls.className = 'bdd-layer-controls';
        controls.hidden = !overlay.settingsOpen;

        settingsToggle.addEventListener('click', () => {
            overlay.settingsOpen = !overlay.settingsOpen;
            renderCustomSiteOverlayControls();
        });

        const showNamesLabel = document.createElement('label');
        showNamesLabel.className = 'bdd-inline-check';
        const showNamesInput = document.createElement('input');
        showNamesInput.type = 'checkbox';
        showNamesInput.checked = overlay.showSiteNames;
        showNamesInput.addEventListener('change', (event) => {
            overlay.showSiteNames = event.target.checked;
            renderCustomSiteOverlays();
        });
        const showNamesText = document.createElement('span');
        showNamesText.textContent = 'Show site names';
        showNamesLabel.appendChild(showNamesInput);
        showNamesLabel.appendChild(showNamesText);
        controls.appendChild(showNamesLabel);

        const legendNameLabel = document.createElement('label');
        legendNameLabel.className = 'text-tool-field bdd-legend-field';
        const legendNameTitle = document.createElement('span');
        legendNameTitle.textContent = 'Legend name';
        const legendNameInput = document.createElement('input');
        legendNameInput.type = 'text';
        legendNameInput.value = overlay.legendName || overlay.label;
        legendNameInput.placeholder = overlay.label;
        legendNameInput.addEventListener('input', (event) => {
            overlay.legendName = event.target.value;
            updateLegend();
        });
        legendNameLabel.appendChild(legendNameTitle);
        legendNameLabel.appendChild(legendNameInput);
        controls.appendChild(legendNameLabel);

        const grid = document.createElement('div');
        grid.className = 'bdd-mini-grid';

        const siteSizeRow = document.createElement('div');
        siteSizeRow.className = 'bdd-range-row';
        siteSizeRow.innerHTML = `
            <div class="bdd-range-header">
              <span>Site size</span>
              <span class="bdd-range-value">${Math.round(overlay.settings.siteRadius)} px</span>
            </div>
        `;
        const siteSizeInput = document.createElement('input');
        siteSizeInput.type = 'range';
        siteSizeInput.className = 'bdd-range-input';
        siteSizeInput.min = '2';
        siteSizeInput.max = '16';
        siteSizeInput.step = '1';
        siteSizeInput.value = String(overlay.settings.siteRadius);
        siteSizeInput.addEventListener('input', (event) => {
            overlay.settings.siteRadius = Number(event.target.value);
            renderCustomSiteOverlayControls();
            renderCustomSiteOverlays();
        });
        siteSizeRow.appendChild(siteSizeInput);

        const siteOpacityRow = document.createElement('div');
        siteOpacityRow.className = 'bdd-range-row';
        siteOpacityRow.innerHTML = `
            <div class="bdd-range-header">
              <span>Site opacity</span>
              <span class="bdd-range-value">${Math.round(overlay.settings.siteOpacity * 100)}%</span>
            </div>
        `;
        const siteOpacityInput = document.createElement('input');
        siteOpacityInput.type = 'range';
        siteOpacityInput.className = 'bdd-range-input';
        siteOpacityInput.min = '0.1';
        siteOpacityInput.max = '1';
        siteOpacityInput.step = '0.05';
        siteOpacityInput.value = String(overlay.settings.siteOpacity);
        siteOpacityInput.addEventListener('input', (event) => {
            overlay.settings.siteOpacity = Number(event.target.value);
            renderCustomSiteOverlayControls();
            renderCustomSiteOverlays();
        });
        siteOpacityRow.appendChild(siteOpacityInput);

        grid.appendChild(siteSizeRow);
        grid.appendChild(siteOpacityRow);
        controls.appendChild(grid);

        row.appendChild(visibility);
        row.appendChild(actions);
        row.appendChild(settingsToggle);
        row.appendChild(colorInput);
        row.appendChild(count);
        row.appendChild(controls);
        kmlSiteOverlayList.appendChild(row);
    });
}

function renderCustomSiteOverlays() {
    const group = state.mapLayerGroups.customSiteOverlays;
    group.clearLayers();

    if (!state.customSiteOverlays.length) {
        updateLegend();
        return;
    }

    const bounds = map.getBounds().pad(0.15);
    state.customSiteOverlays.forEach((overlay) => {
        if (!overlay.visible) return;
        const items = collectSiteBddItemsInBounds(overlay.pointGrid, bounds);
        items.forEach((point) => {
            const layer = createCustomSiteOverlayLayer(point, overlay);
            layer.addTo(group);
            if (layer.bringToFront) {
                layer.bringToFront();
            }
        });
    });
    updateLegend();
}

function resetSiteBddState() {
    loadBuiltInSiteBddData({ showStatus: true }).catch((error) => {
        console.error(error);
        state.siteBdd = createEmptySiteBddState();
        Object.values(state.mapLayerGroups.siteBdds).forEach((group) => group.clearLayers());
        updateSiteBddSummaryText('Built-in sites BDD could not be restored.');
        updateSiteBddHint('');
        updateSiteBddControls();
    });
}

function resetCustomSiteOverlays() {
    state.customSiteOverlays = [];
    state.mapLayerGroups.customSiteOverlays.clearLayers();
    updateCustomSiteOverlaySummary();
    renderCustomSiteOverlayControls();
}

async function processSitesWorkbook(file) {
    updateStatus(true, 'Reading sites workbook...');
    try {
        const XLSX = await loadXlsxModule();
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const payload = createSiteBddPayloadFromWorkbook(XLSX, workbook, file.name);
        state.siteBdd = buildSiteBddStateFromPayload(payload, { fileName: file.name });

        const summaryParts = getSiteBddSummaryParts();
        updateSiteBddSummaryText(`${file.name} imported. ${summaryParts.join(' • ')}. Use Clear to restore the built-in BDD.`);
        updateSiteBddControls();
        renderSiteBddLayers();

    } catch (error) {
        console.error(error);
        alert(`Error parsing sites workbook: ${error.message}`);
    } finally {
        updateStatus(false);
    }
}

async function loadBuiltInSiteBddData(options = {}) {
    const { showStatus = false } = options;
    if (showStatus) {
        updateStatus(true, 'Loading built-in sites BDD...');
    }

    try {
        const response = await fetch(DEFAULT_SITE_BDD_DATA_URL);
        if (!response.ok) {
            throw new Error(`Failed to load built-in sites BDD (${response.status})`);
        }

        const payload = await response.json();
        state.siteBdd = buildSiteBddStateFromPayload(payload, { fileName: payload.fileName || 'Built-in Sites BDD' });
        updateSiteBddSummaryText(`Built-in sites BDD loaded. ${getSiteBddSummaryParts().join(' • ')}`);
        updateSiteBddControls();
        renderSiteBddLayers();
    } finally {
        if (showStatus) {
            updateStatus(false);
        }
    }
}

async function processKmlSiteFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;

    updateStatus(true, files.length === 1 ? `Reading ${files[0].name}...` : `Reading ${files.length} KML/KMZ files...`);
    try {
        const importedOverlays = [];

        for (const file of files) {
            const isKmz = /\.kmz$/i.test(file.name);
            const kmlText = isKmz ? await extractKmlTextFromKmz(file) : await file.text();
            const points = parseKmlSitePoints(kmlText);
            if (!points.length) {
                throw new Error(`${file.name} does not contain any Point placemarks.`);
            }
            importedOverlays.push(createCustomSiteOverlay(file.name, points, state.customSiteOverlays.length + importedOverlays.length));
        }

        state.customSiteOverlays = [...state.customSiteOverlays, ...importedOverlays];
        updateCustomSiteOverlaySummary();
        renderCustomSiteOverlayControls();
        renderCustomSiteOverlays();
    } catch (error) {
        console.error(error);
        alert(`Error importing KML/KMZ sites: ${error.message}`);
    } finally {
        updateStatus(false);
    }
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

function areGeoLayersReady() {
    return Boolean(
        state.layers.regions?.features &&
        state.layers.provinces?.features &&
        state.layers.communes?.features &&
        state.layers.drs?.features
    );
}

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
    if (!state.referencePlaces.length) {
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
                const candidates = state.referencePlaceGrid.get(key);
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

    return state.referencePlaces.reduce((best, candidate) => {
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
        region: findLayerMatchValueForCoordinates(lat, lng, state.layers.regions, state.spatialIndexes.regions),
        dr: findLayerMatchValueForCoordinates(lat, lng, state.layers.drs, state.spatialIndexes.drs),
        province: findLayerMatchValueForCoordinates(lat, lng, state.layers.provinces, state.spatialIndexes.provinces),
        commune: findLayerMatchValueForCoordinates(lat, lng, state.layers.communes, state.spatialIndexes.communes)
    };
}

function getReferencePlaceCacheKey(place) {
    return place.osmId || `${normalizeSearchText(place.name)}|${roundTo(place.lat, 6)}|${roundTo(place.lng, 6)}`;
}

function getReferencePlaceAdminContext(place) {
    const key = getReferencePlaceCacheKey(place);
    if (state.referencePlaceAdminCache.has(key)) {
        return state.referencePlaceAdminCache.get(key);
    }

    const adminContext = getAdminContextForCoordinates(place.lat, place.lng);
    state.referencePlaceAdminCache.set(key, adminContext);
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
                    const places = state.referencePlaceNameIndex.get(aliasForm) || [];
                    places.forEach((place) => {
                        candidates.set(getReferencePlaceCacheKey(place), place);
                    });
                });
            });
        });
    });

    return [...candidates.values()];
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

function formatDistanceKm(distanceKm) {
    if (!Number.isFinite(distanceKm)) return '-';
    if (distanceKm < 1) return distanceKm.toFixed(2);
    if (distanceKm < 10) return distanceKm.toFixed(1);
    return Math.round(distanceKm).toString();
}

function formatNearestPlaceLabel(point) {
    if (!point.nearestPlaceName) return '-';
    const classLabel = point.nearestPlaceClass ? ` (${point.nearestPlaceClass})` : '';
    return `${point.nearestPlaceName}${classLabel}`;
}

function formatLocalityReferenceLabel(point) {
    if (!point.localityReferenceName) return '-';
    const classLabel = point.localityReferenceClass ? ` (${point.localityReferenceClass})` : '';
    const note = point.localityReferenceExactMatch ? '' : ' <span class="match-note">not matched 100%</span>';
    const sourceNote = point.localityReferenceSource === 'Wikimapia'
        ? ' <span class="match-note">Wikimapia</span>'
        : '';
    return `${escapeHtml(point.localityReferenceName)}${classLabel}${note}${sourceNote}`;
}

function getBBoxArea(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return Number.POSITIVE_INFINITY;
    return Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

function findInhabitedAreaContext(lat, lng) {
    if (!state.inhabitedAreas.length) {
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

    state.inhabitedAreas.forEach((area) => {
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

function formatInhabitedAreaLabel(point) {
    if (point.isInsideInhabitedArea && point.inhabitedAreaName) {
        const classLabel = point.inhabitedAreaClass ? ` (${point.inhabitedAreaClass})` : '';
        return `${point.inhabitedAreaName}${classLabel}`;
    }

    if (point.nearestInhabitedAreaName) {
        const classLabel = point.nearestInhabitedAreaClass ? ` (${point.nearestInhabitedAreaClass})` : '';
        const distanceLabel = Number.isFinite(point.nearestInhabitedAreaDistanceKm)
            ? ` - ${formatDistanceKm(point.nearestInhabitedAreaDistanceKm)} km`
            : '';
        return `${point.nearestInhabitedAreaName}${classLabel}${distanceLabel}`;
    }

    return '-';
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

function getRiskPillClass(level) {
    if (level === 'High') return 'risk-high';
    if (level === 'Medium') return 'risk-medium';
    return 'risk-low';
}

function createRiskPillElement(point) {
    const level = point.reviewRiskLevel || 'Low';
    const score = Number.isFinite(point.reviewRiskScore) ? Math.round(point.reviewRiskScore) : 0;
    const title = point.reviewRiskReasons?.length
        ? `Review risk: ${point.reviewRiskReasons.join('; ')}`
        : 'Review risk: no major review signals';
    const pill = document.createElement('span');
    pill.className = `risk-pill ${getRiskPillClass(level)}`;
    pill.title = title;
    pill.textContent = `${level} ${score}`;
    return pill;
}

function getFeatureDisplayName(feature, type) {
    const props = feature?.properties || {};
    if (type === 'region') return props.Nom_Region || props.Nom_region || props.NAME || '';
    if (type === 'province') return props.Nom_Provin || props.Nom_provin || props.NAME || '';
    if (type === 'commune') return props.Nom_Commun || props.Nom_commun || props.NAME || '';
    return props.NAME || props.Name || '';
}

function formatSearchResultLabel(result) {
    if (!result) return '';
    return result.subLabel ? `${result.name} (${result.subLabel})` : result.name;
}

function getSearchSourceLabel(category) {
    if (category === 'site') return 'Imported site';
    if (category === 'lieu') return 'Lieux reference';
    if (category === 'inhabited_area') return 'Zones habitees';
    if (category === 'commune') return 'Commune boundary';
    if (category === 'province') return 'Province boundary';
    if (category === 'dr') return 'DR boundary';
    if (category === 'region') return 'Region boundary';
    if (category === 'wikimapia') return 'Wikimapia';
    return category.replace(/_/g, ' ');
}

function getSearchResultMetaLabel(result) {
    const parts = [
        result.sourceLabel || getSearchSourceLabel(result.category),
        result.subLabel
    ].filter(Boolean);
    return parts.join(' • ');
}

function getSearchResultWikimapiaLabel(result) {
    if (!result?.wikimapiaSuggestionName) return '';
    const classLabel = result.wikimapiaSuggestionClass ? ` (${result.wikimapiaSuggestionClass})` : '';
    return `Wikimapia: ${result.wikimapiaSuggestionName}${classLabel}`;
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

function collectSearchCandidates() {
    const candidates = [];

    state.processedPoints.forEach((point) => {
        const fields = [
            point.id,
            point.displayName,
            point.original?.Localite,
            point.original?.SousLocalite,
            point.original?.Commune,
            point.original?.Province
        ].filter(Boolean);

        candidates.push({
            category: 'site',
            name: point.displayName || point.id,
            subLabel: 'Imported site',
            sourceLabel: getSearchSourceLabel('site'),
            lat: point.lat,
            lng: point.lng,
            point,
            fields: [...fields, `${point.displayName || point.id} imported site`]
        });
    });

    state.referencePlaces.forEach((place) => {
        candidates.push({
            category: 'lieu',
            name: place.name,
            subLabel: place.fclass || 'place',
            sourceLabel: getSearchSourceLabel('lieu'),
            lat: place.lat,
            lng: place.lng,
            place,
            fields: [place.name, place.fclass, `${place.name} ${place.fclass || ''}`].filter(Boolean)
        });
    });

    state.inhabitedAreas.forEach((area) => {
        candidates.push({
            category: 'inhabited_area',
            name: area.name,
            subLabel: area.fclass || 'inhabited area',
            sourceLabel: getSearchSourceLabel('inhabited_area'),
            lat: area.centroid?.lat,
            lng: area.centroid?.lng,
            area,
            bounds: area.bbox,
            fields: [area.name, area.fclass, `${area.name} ${area.fclass || ''}`].filter(Boolean)
        });
    });

    [
        ['region', state.layers.regions?.features || []],
        ['dr', state.layers.drs?.features || []],
        ['province', state.layers.provinces?.features || []],
        ['commune', state.layers.communes?.features || []]
    ].forEach(([type, features]) => {
        features.forEach((feature) => {
            const name = getFeatureDisplayName(feature, type);
            if (!name) return;

            const center = turf.centroid(feature).geometry.coordinates;
            candidates.push({
                category: type,
                name,
                subLabel: type === 'dr' ? 'Direction Régionale' : type,
                sourceLabel: getSearchSourceLabel(type),
                lat: center[1],
                lng: center[0],
                feature,
                fields: [name, `${name} ${type}`]
            });
        });
    });

    return candidates;
}

function findLocalSearchResults(queryText) {
    const queryVariants = extractLocalityHints(queryText).flatMap((hint) => buildSearchVariants(hint));
    if (!queryVariants.length) return [];

    const priorityBonus = {
        site: 40,
        lieu: 28,
        inhabited_area: 22,
        commune: 18,
        province: 14,
        dr: 10,
        region: 6
    };

    const matches = [];

    collectSearchCandidates().forEach((candidate) => {
        const candidateVariants = [];
        candidate.fields.forEach((field) => {
            buildSearchVariants(field).forEach((variant) => {
                candidateVariants.push(variant);
            });
        });

        let bestFieldScore = -1;
        queryVariants.forEach((queryVariant) => {
            candidateVariants.forEach((candidateVariant) => {
                const score = scoreSearchField(queryVariant.value, candidateVariant.value);
                if (score < 0) return;

                const adjustedScore = score - queryVariant.penalty - candidateVariant.penalty;
                if (adjustedScore > bestFieldScore) {
                    bestFieldScore = adjustedScore;
                }
            });
        });

        if (bestFieldScore < 0) return;

        const totalScore = bestFieldScore + (priorityBonus[candidate.category] || 0);
        matches.push({
            ...candidate,
            totalScore
        });
    });

    matches.sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return String(a.name).localeCompare(String(b.name));
    });

    const deduped = [];
    const seen = new Set();
    matches.forEach((match) => {
        const key = `${match.category}:${normalizeSearchText(match.name)}:${roundTo(match.lat || 0, 5)}:${roundTo(match.lng || 0, 5)}`;
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push(match);
    });

    return deduped.slice(0, 5);
}

function getActivePoint() {
    if (!state.activePointId) return null;
    return state.processedPoints.find((point) => String(point.id) === String(state.activePointId)) || null;
}

function getWikimapiaApiKey() {
    const envKey = String(import.meta.env.VITE_WIKIMAPIA_API_KEY || '').trim();
    if (envKey) {
        return envKey;
    }

    try {
        const storedKey = String(window.localStorage.getItem('wikimapia_api_key') || '').trim();
        if (storedKey) {
            return storedKey;
        }
    } catch (error) {
        console.warn('Unable to read Wikimapia API key from localStorage.', error);
    }

    return '';
}

function updateWikimapiaKeyStatus() {
    if (!wikimapiaApiKeyInput || !saveWikimapiaKeyBtn || !clearWikimapiaKeyBtn || !wikimapiaKeyStatus) {
        return;
    }

    const envKey = String(import.meta.env.VITE_WIKIMAPIA_API_KEY || '').trim();
    const activeKey = getWikimapiaApiKey();

    if (envKey) {
        wikimapiaApiKeyInput.value = '';
        wikimapiaApiKeyInput.placeholder = 'Using Vite env API key';
        wikimapiaApiKeyInput.disabled = true;
        saveWikimapiaKeyBtn.disabled = true;
        clearWikimapiaKeyBtn.disabled = true;
        wikimapiaKeyStatus.textContent = 'Wikimapia search is on via Vite env key.';
        wikimapiaKeyStatus.classList.add('active');
        return;
    }

    wikimapiaApiKeyInput.disabled = false;
    saveWikimapiaKeyBtn.disabled = false;
    clearWikimapiaKeyBtn.disabled = false;
    wikimapiaApiKeyInput.placeholder = 'Wikimapia API key';

    if (activeKey) {
        wikimapiaApiKeyInput.value = activeKey;
        wikimapiaKeyStatus.textContent = 'Wikimapia search is on.';
        wikimapiaKeyStatus.classList.add('active');
    } else {
        wikimapiaApiKeyInput.value = '';
        wikimapiaKeyStatus.textContent = 'Wikimapia search is off.';
        wikimapiaKeyStatus.classList.remove('active');
    }
}

function saveWikimapiaApiKey() {
    const key = String(wikimapiaApiKeyInput.value || '').trim();
    try {
        if (key) {
            window.localStorage.setItem('wikimapia_api_key', key);
            state.wikimapiaCache.clear();
        } else {
            window.localStorage.removeItem('wikimapia_api_key');
            state.wikimapiaCache.clear();
        }
    } catch (error) {
        console.warn('Unable to store Wikimapia API key.', error);
    }

    updateWikimapiaKeyStatus();
}

function clearWikimapiaApiKey() {
    try {
        window.localStorage.removeItem('wikimapia_api_key');
        state.wikimapiaCache.clear();
    } catch (error) {
        console.warn('Unable to clear Wikimapia API key.', error);
    }

    updateWikimapiaKeyStatus();
}

function buildWikimapiaSearchTerms(queryText) {
    const raw = String(queryText || '').trim();
    const terms = [];
    const seen = new Set();

    const pushTerm = (term) => {
        const rawTerm = String(term || '').trim();
        const normalizedTerm = normalizeSearchText(rawTerm);
        if (!normalizedTerm || normalizedTerm.length < 2 || seen.has(normalizedTerm)) {
            return;
        }
        seen.add(normalizedTerm);
        terms.push(rawTerm);
    };

    pushTerm(raw);

    [...raw.matchAll(/\(([^)]+)\)/g)].forEach((match) => {
        pushTerm(match[1]);
    });

    extractLocalityHints(raw).forEach((hint) => {
        pushTerm(hint);
    });

    return terms.slice(0, 3);
}

function getWikimapiaContextParams() {
    const activePoint = getActivePoint();
    if (activePoint) {
        return {
            lat: activePoint.lat,
            lon: activePoint.lng,
            distance: 100000
        };
    }

    if (map.getZoom() >= BADGE_MIN_ZOOM) {
        const center = map.getCenter();
        return {
            lat: center.lat,
            lon: center.lng,
            distance: 150000
        };
    }

    return null;
}

function buildWikimapiaCacheKey(queryText) {
    const context = getWikimapiaContextParams();
    return [
        normalizeSearchText(queryText),
        roundTo(context?.lat || 0, 3),
        roundTo(context?.lon || 0, 3),
        context?.distance || 0
    ].join('|');
}

function requestWikimapiaJsonp(params) {
    return new Promise((resolve, reject) => {
        const callbackName = `__wikimapiaJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const url = new URL('https://api.wikimapia.org/');

        Object.entries(params).forEach(([key, value]) => {
            if (value == null || value === '') return;
            url.searchParams.set(key, String(value));
        });

        url.searchParams.set('format', 'jsonp');
        url.searchParams.set('jsoncallback', callbackName);

        const script = document.createElement('script');
        let settled = false;

        const cleanup = () => {
            delete window[callbackName];
            script.remove();
            clearTimeout(timeoutId);
        };

        window[callbackName] = (payload) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(payload);
        };

        script.onerror = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Unable to reach Wikimapia.'));
        };

        const timeoutId = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Wikimapia request timed out.'));
        }, 8000);

        script.src = url.toString();
        document.body.appendChild(script);
    });
}

function extractWikimapiaPlaces(payload) {
    if (Array.isArray(payload?.places)) return payload.places;
    if (Array.isArray(payload?.folder)) return payload.folder;
    if (Array.isArray(payload?.result)) return payload.result;
    if (Array.isArray(payload?.search)) return payload.search;
    if (Array.isArray(payload)) return payload;
    return [];
}

function extractWikimapiaBounds(rawPlace) {
    const polygon = rawPlace?.polygon;
    if (!Array.isArray(polygon) || polygon.length === 0) {
        return null;
    }

    const coords = [];

    if (typeof polygon[0] === 'number') {
        for (let index = 0; index < polygon.length - 1; index += 2) {
            const lng = Number(polygon[index]);
            const lat = Number(polygon[index + 1]);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                coords.push([lng, lat]);
            }
        }
    } else {
        polygon.forEach((point) => {
            const lat = Number(point?.lat ?? point?.y);
            const lng = Number(point?.lon ?? point?.lng ?? point?.x);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                coords.push([lng, lat]);
            }
        });
    }

    if (!coords.length) {
        return null;
    }

    const lngs = coords.map((coord) => coord[0]);
    const lats = coords.map((coord) => coord[1]);
    return [
        Math.min(...lngs),
        Math.min(...lats),
        Math.max(...lngs),
        Math.max(...lats)
    ];
}

function extractWikimapiaCategory(rawPlace) {
    const labels = [];

    [rawPlace?.tags, rawPlace?.categories].forEach((items) => {
        if (!Array.isArray(items)) return;
        items.forEach((item) => {
            if (typeof item === 'string') {
                labels.push(item);
                return;
            }

            const title = item?.title || item?.name;
            if (title) {
                labels.push(title);
            }
        });
    });

    return labels[0] || rawPlace?.type || rawPlace?.kind || 'place';
}

function getWikimapiaCategoryBonus(categoryLabel) {
    const normalized = normalizeSearchText(categoryLabel);
    if (!normalized) return 0;
    if (['village', 'hamlet', 'town', 'locality', 'suburb'].some((term) => normalized.includes(term))) {
        return 10;
    }
    if (['district', 'neighbourhood', 'neighborhood'].some((term) => normalized.includes(term))) {
        return 6;
    }
    return 0;
}

function scoreWikimapiaResult(queryText, result) {
    const queryVariants = extractLocalityHints(queryText).flatMap((hint) => buildSearchVariants(hint));
    const candidateFields = [result.name, result.subLabel, `${result.name} ${result.subLabel || ''}`]
        .filter(Boolean)
        .flatMap((field) => buildSearchVariants(field));

    let bestScore = -1;

    queryVariants.forEach((queryVariant) => {
        candidateFields.forEach((candidateVariant) => {
            const score = scoreSearchField(queryVariant.value, candidateVariant.value);
            if (score < 0) return;

            const adjustedScore = score - queryVariant.penalty - candidateVariant.penalty;
            if (adjustedScore > bestScore) {
                bestScore = adjustedScore;
            }
        });
    });

    if (bestScore < 0) {
        return -1;
    }

    let totalScore = bestScore + 16 + getWikimapiaCategoryBonus(result.subLabel);

    const activePoint = getActivePoint();
    if (activePoint) {
        const distanceKm = haversineDistanceKm(activePoint.lat, activePoint.lng, result.lat, result.lng);
        if (distanceKm <= 2) totalScore += 18;
        else if (distanceKm <= 5) totalScore += 12;
        else if (distanceKm <= 12) totalScore += 6;
        else if (distanceKm > 50) totalScore -= 12;
    }

    return totalScore;
}

function scoreResultToWikimapiaPair(localResult, wikimapiaResult, queryText) {
    if (!localResult || !wikimapiaResult) return -1;
    if (!Number.isFinite(localResult.lat) || !Number.isFinite(localResult.lng)) return -1;
    if (!Number.isFinite(wikimapiaResult.lat) || !Number.isFinite(wikimapiaResult.lng)) return -1;

    const directNameScore = scoreSearchField(
        normalizeSearchText(localResult.name),
        normalizeSearchText(wikimapiaResult.name)
    );
    const localityHintScore = queryText
        ? getBestLocalityReferenceScore(queryText, wikimapiaResult.name).score
        : -1;
    const distanceKm = haversineDistanceKm(localResult.lat, localResult.lng, wikimapiaResult.lat, wikimapiaResult.lng);

    if (distanceKm > 20) {
        return -1;
    }

    let pairScore = Math.max(directNameScore, localityHintScore);

    if (pairScore < 0 && distanceKm <= 2) {
        pairScore = 620;
    }

    if (pairScore < 0) {
        return -1;
    }

    if (distanceKm <= 1) pairScore += 40;
    else if (distanceKm <= 3) pairScore += 25;
    else if (distanceKm <= 8) pairScore += 10;
    else pairScore -= 10;

    return pairScore;
}

function normalizeWikimapiaResult(rawPlace, queryText, sourceQuery) {
    const name = String(rawPlace?.title || rawPlace?.name || '').trim();
    const lat = Number(rawPlace?.location?.lat ?? rawPlace?.lat);
    const lng = Number(rawPlace?.location?.lon ?? rawPlace?.location?.lng ?? rawPlace?.lon ?? rawPlace?.lng);

    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }

    const result = {
        category: 'wikimapia',
        sourceLabel: getSearchSourceLabel('wikimapia'),
        name,
        subLabel: extractWikimapiaCategory(rawPlace),
        lat,
        lng,
        bounds: extractWikimapiaBounds(rawPlace),
        wikimapiaId: rawPlace?.id ?? null,
        url: rawPlace?.url
            ? String(rawPlace.url).startsWith('http')
                ? rawPlace.url
                : `https://wikimapia.org${rawPlace.url}`
            : `https://wikimapia.org/#lat=${lat}&lon=${lng}&z=15&l=0&m=b`,
        sourceQuery
    };

    result.totalScore = scoreWikimapiaResult(queryText, result);
    return result.totalScore >= 0 ? result : null;
}

async function searchWikimapiaResults(queryText) {
    const apiKey = getWikimapiaApiKey();
    if (!apiKey) {
        return [];
    }

    const cacheKey = buildWikimapiaCacheKey(queryText);
    if (state.wikimapiaCache.has(cacheKey)) {
        return state.wikimapiaCache.get(cacheKey);
    }

    const terms = buildWikimapiaSearchTerms(queryText);
    if (!terms.length) {
        return [];
    }

    const context = getWikimapiaContextParams();
    const requests = terms.map((term) => requestWikimapiaJsonp({
        function: 'place.search',
        key: apiKey,
        q: term,
        count: WIKIMAPIA_RESULT_LIMIT,
        language: 'en',
        data_blocks: 'main,location',
        lat: context?.lat,
        lon: context?.lon,
        distance: context?.distance
    }).then((payload) => ({ term, payload })));

    const settled = await Promise.allSettled(requests);
    const results = [];

    settled.forEach((entry) => {
        if (entry.status !== 'fulfilled') {
            console.warn('Wikimapia search request failed.', entry.reason);
            return;
        }

        extractWikimapiaPlaces(entry.value.payload).forEach((rawPlace) => {
            const normalized = normalizeWikimapiaResult(rawPlace, queryText, entry.value.term);
            if (normalized) {
                results.push(normalized);
            }
        });
    });

    const deduped = [];
    const seen = new Set();
    results
        .sort((a, b) => {
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
            return String(a.name).localeCompare(String(b.name));
        })
        .forEach((result) => {
            const key = `${normalizeSearchText(result.name)}:${roundTo(result.lat, 5)}:${roundTo(result.lng, 5)}`;
            if (seen.has(key)) return;
            seen.add(key);
            deduped.push(result);
        });

    const topResults = deduped.slice(0, WIKIMAPIA_RESULT_LIMIT);
    state.wikimapiaCache.set(cacheKey, topResults);
    return topResults;
}

function mergeSearchResults(localResults, wikimapiaResults, queryText = '') {
    const merged = [];
    const bestByKey = new Map();
    const pairedWikimapiaKeys = new Set();

    const uniqueLocalResults = localResults.map((result) => ({ ...result }));
    const uniqueWikimapiaResults = wikimapiaResults.map((result) => ({ ...result }));

    uniqueLocalResults.forEach((localResult) => {
        let bestPair = null;
        let bestPairScore = -1;

        uniqueWikimapiaResults.forEach((wikimapiaResult) => {
            const pairScore = scoreResultToWikimapiaPair(localResult, wikimapiaResult, queryText);
            if (pairScore > bestPairScore) {
                bestPairScore = pairScore;
                bestPair = wikimapiaResult;
            }
        });

        if (bestPair && bestPairScore >= 700) {
            localResult.wikimapiaSuggestionName = bestPair.name;
            localResult.wikimapiaSuggestionClass = bestPair.subLabel || '';
            pairedWikimapiaKeys.add(
                `${normalizeSearchText(bestPair.name)}:${roundTo(bestPair.lat || 0, 5)}:${roundTo(bestPair.lng || 0, 5)}`
            );
        }
    });

    [...uniqueLocalResults, ...uniqueWikimapiaResults].forEach((result) => {
        if (result.category === 'wikimapia') {
            const pairedKey = `${normalizeSearchText(result.name)}:${roundTo(result.lat || 0, 5)}:${roundTo(result.lng || 0, 5)}`;
            if (pairedWikimapiaKeys.has(pairedKey)) {
                return;
            }
        }

        const key = `${result.category}:${normalizeSearchText(result.name)}:${roundTo(result.lat || 0, 5)}:${roundTo(result.lng || 0, 5)}`;
        const current = bestByKey.get(key);
        if (!current || (result.totalScore || 0) > (current.totalScore || 0)) {
            bestByKey.set(key, result);
        }
    });

    bestByKey.forEach((result) => merged.push(result));
    merged.sort((a, b) => {
        if ((b.totalScore || 0) !== (a.totalScore || 0)) {
            return (b.totalScore || 0) - (a.totalScore || 0);
        }
        return String(a.name).localeCompare(String(b.name));
    });

    return merged.slice(0, 5);
}

async function findSearchResults(queryText) {
    const localResults = findLocalSearchResults(queryText);
    const wikimapiaResults = await searchWikimapiaResults(queryText);
    return mergeSearchResults(localResults, wikimapiaResults, queryText);
}

function clearSearchSelection({ keepInput = false } = {}) {
    if (state.searchCircle) {
        map.removeLayer(state.searchCircle);
        state.searchCircle = null;
    }
    map.closePopup();
    searchResultsDropdown.style.display = 'none';
    searchResultsDropdown.innerHTML = '';
    if (!keepInput) {
        siteSearchInput.value = '';
    }
}

function getSearchResultRadiusMeters(result) {
    const bbox = result.bounds
        || result.area?.bbox
        || result.feature?.bbox
        || turf.bbox(result.feature || turf.point([result.lng, result.lat]));

    if (Array.isArray(bbox) && bbox.length === 4) {
        const diagonalKm = haversineDistanceKm(bbox[1], bbox[0], bbox[3], bbox[2]);
        if (Number.isFinite(diagonalKm) && diagonalKm > 0) {
            return Math.max(600, Math.min(30000, (diagonalKm * 1000) / 2));
        }
    }

    if (result.category === 'site') return 600;
    if (result.category === 'lieu') return 900;
    if (result.category === 'inhabited_area') return 1400;
    if (result.category === 'commune') return 5000;
    if (result.category === 'province') return 12000;
    if (result.category === 'region' || result.category === 'dr') return 20000;
    if (result.category === 'wikimapia') return 900;
    return 1000;
}

function drawSearchCircle(result) {
    if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) return;

    if (state.searchCircle) {
        map.removeLayer(state.searchCircle);
    }

    state.searchCircle = L.circle([result.lat, result.lng], {
        radius: getSearchResultRadiusMeters(result),
        color: '#f59e0b',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.12
    }).addTo(map);
}

function fillManualFieldsFromSearchResult(result) {
    manualSiteName.value = result.name || '';
    manualLat.value = Number.isFinite(result.lat) ? result.lat.toFixed(6) : '';
    manualLng.value = Number.isFinite(result.lng) ? result.lng.toFixed(6) : '';
}

function isQueryLinkedToPoint(point, queryText) {
    const normalizedQuery = normalizeSearchText(queryText);
    if (!point || !normalizedQuery) return false;

    const candidateFields = [
        point.displayName,
        point.original?.Localite,
        point.original?.SousLocalite,
        point.id
    ].filter(Boolean);

    return candidateFields.some((field) => {
        const normalizedField = normalizeSearchText(field);
        if (!normalizedField) return false;
        if (normalizedField.includes(normalizedQuery) || normalizedQuery.includes(normalizedField)) {
            return true;
        }
        return (
            getBestLocalityReferenceScore(field, queryText).score >= 700 ||
            getBestLocalityReferenceScore(queryText, field).score >= 700
        );
    });
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

function applyWikimapiaResultToActivePoint(result) {
    const activePoint = getActivePoint();
    const query = siteSearchInput.value.trim();

    if (!activePoint || !isQueryLinkedToPoint(activePoint, query)) {
        return null;
    }

    const localityRawName = activePoint.original?.Localite || activePoint.displayName || activePoint.id;
    const matchQuality = getBestLocalityReferenceScore(localityRawName, result.name);
    const override = {
        name: result.name,
        distanceKm: haversineDistanceKm(activePoint.lat, activePoint.lng, result.lat, result.lng),
        fclass: result.subLabel || 'place',
        isExactMatch: matchQuality.isExact,
        lat: result.lat,
        lng: result.lng,
        url: result.url
    };

    state.localityReferenceOverrides.set(activePoint.id, override);
    applyLocalityReferenceToPoint(activePoint, override, 'Wikimapia', result.url);
    renderTable();
    return activePoint;
}

function openSearchResult(result) {
    if (!result) return;

    drawSearchCircle(result);
    searchResultsDropdown.style.display = 'none';
    fillManualFieldsFromSearchResult(result);

    if (result.category === 'site' && result.point) {
        focusPointOnMap(result.point);
        return;
    }

    if (result.category === 'wikimapia') {
        const updatedPoint = applyWikimapiaResultToActivePoint(result);
        if (updatedPoint) {
            focusPointOnMap(updatedPoint, { zoom: 14 });
            return;
        }
    }

    const popupLabel = formatSearchResultLabel(result);

    if (Number.isFinite(result.lat) && Number.isFinite(result.lng)) {
        map.fitBounds(state.searchCircle.getBounds(), { padding: [40, 40] });
    }

    if (Number.isFinite(result.lat) && Number.isFinite(result.lng)) {
        L.popup()
            .setLatLng([result.lat, result.lng])
            .setContent(`
                <b>${escapeHtml(popupLabel)}</b><br>
                Source: ${escapeHtml(result.sourceLabel || getSearchSourceLabel(result.category))}<br>
                Lat/Lon: ${roundTo(result.lat, 6)}, ${roundTo(result.lng, 6)}
            `)
            .openOn(map);
    }
}

function renderSearchResults(results, { loadingWikimapia = false } = {}) {
    if (!results.length) {
        searchResultsDropdown.innerHTML = loadingWikimapia
            ? '<div class="search-result-item"><span class="search-result-title">Searching Wikimapia...</span><span class="search-result-meta">Checking local data and Wikimapia suggestions.</span></div>'
            : '<div class="search-result-item"><span class="search-result-title">No result found</span><span class="search-result-meta">Try site, locality, commune, province, DR, or region.</span></div>';
        searchResultsDropdown.style.display = 'block';
        return;
    }

    searchResultsDropdown.innerHTML = '';
    results.forEach((result, index) => {
        const item = document.createElement('div');
        item.className = `search-result-item${index === 0 ? ' active' : ''}`;
        item.innerHTML = `
            <span class="search-result-title">${escapeHtml(formatSearchResultLabel(result))}</span>
            <span class="search-result-meta">${escapeHtml(getSearchResultMetaLabel(result))}</span>
            ${result.wikimapiaSuggestionName ? `<span class="search-result-alias">${escapeHtml(getSearchResultWikimapiaLabel(result))}</span>` : ''}
        `;
        item.addEventListener('click', () => {
            siteSearchInput.value = result.name;
            openSearchResult(result);
        });
        searchResultsDropdown.appendChild(item);
    });

    if (loadingWikimapia) {
        const hint = document.createElement('div');
        hint.className = 'search-result-hint';
        hint.textContent = 'Searching Wikimapia...';
        searchResultsDropdown.appendChild(hint);
    }

    searchResultsDropdown.style.display = 'block';
}

async function runSiteSearch() {
    const query = siteSearchInput.value.trim();
    if (!query) return;

    const requestId = ++state.searchRequestId;
    const localResults = findLocalSearchResults(query);
    const hasWikimapiaKey = Boolean(getWikimapiaApiKey());
    renderSearchResults(localResults, { loadingWikimapia: hasWikimapiaKey });

    const results = await findSearchResults(query);
    if (requestId !== state.searchRequestId || normalizeSearchText(siteSearchInput.value) !== normalizeSearchText(query)) {
        return;
    }

    renderSearchResults(results);
}

function getNetworkBadgeLabel(point) {
    const rawValue = point.original?.DeclarationIAM
        || point.original?.['Réseaux mobiles Voix et Data\n(Déclaration d\'IAM)']
        || point.original?.['Réseaux mobiles Voix et Data (2G ou 2G/3G ou 2G/3G/4G)']
        || point.original?.network
        || 'NC';

    const normalized = String(rawValue)
        .trim()
        .toUpperCase()
        .replace(/\s*\/\s*/g, '/')
        .replace(/\s+/g, ' ');

    if (normalized === '2G') return '2G';
    if (normalized === '2G/3G') return '2G/3G';
    if (normalized === '2G/3G/4G') return '2G/3G/4G';
    if (normalized === '2G/3G/4G/5G') return '2G/3G/4G/5G';
    if (normalized === 'NC') return 'NC';
    return normalized || 'NC';
}

function getNetworkBadgeClass(label) {
    if (label === '2G') return 'network-badge-2g';
    if (label === '2G/3G') return 'network-badge-2g3g';
    if (label === '2G/3G/4G') return 'network-badge-2g3g4g';
    if (label === '2G/3G/4G/5G') return 'network-badge-2g3g4g5g';
    if (label === 'NC') return 'network-badge-nc';
    return 'network-badge-default';
}

function isManualAddedPoint(point) {
    return Boolean(point?.isManualAdded || point?.original?.__manualAdded);
}

function updateNetworkBadgeControls() {
    NETWORK_BADGE_OPTIONS.forEach((label) => {
        const control = networkBadgeControls[label];
        if (control) {
            control.checked = state.visibleNetworkBadges.has(label);
        }
    });

    if (toggleBadgesBtn) {
        const visibleCount = [...state.visibleNetworkBadges].length;
        toggleBadgesBtn.textContent = visibleCount === NETWORK_BADGE_OPTIONS.length
            ? 'Badges'
            : `Badges (${visibleCount})`;
    }
}

function clampBadgePopoverPosition(left, top) {
    if (!badgeFilterPopover) {
        return { left, top };
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rect = badgeFilterPopover.getBoundingClientRect();
    const maxLeft = Math.max(12, viewportWidth - rect.width - 12);
    const maxTop = Math.max(12, viewportHeight - rect.height - 12);

    return {
        left: Math.min(Math.max(12, left), maxLeft),
        top: Math.min(Math.max(12, top), maxTop)
    };
}

function applyBadgePopoverPosition(left, top) {
    if (!badgeFilterPopover) return;
    const next = clampBadgePopoverPosition(left, top);
    badgePopoverPosition = next;
    badgeFilterPopover.style.left = `${next.left}px`;
    badgeFilterPopover.style.top = `${next.top}px`;
    badgeFilterPopover.style.right = 'auto';
}

function applyLegendPosition(left, top) {
    if (!drLegend) return;
    const parent = drLegend.offsetParent || document.body;
    const padding = 10;
    const maxX = parent.clientWidth - drLegend.offsetWidth - padding;
    const maxY = parent.clientHeight - drLegend.offsetHeight - padding;

    left = Math.max(padding, Math.min(left, maxX));
    top = Math.max(padding, Math.min(top, maxY));

    drLegend.style.left = `${left}px`;
    drLegend.style.top = `${top}px`;
    drLegend.style.bottom = 'auto';
    drLegend.style.right = 'auto';

    legendPosition = { left, top };
}


function openBadgeFilterPopover() {
    if (!badgeFilterPopover || !toggleBadgesBtn) return;

    badgeFilterPopover.removeAttribute('hidden');
    toggleBadgesBtn.setAttribute('aria-expanded', 'true');

    if (!badgePopoverPosition) {
        const buttonRect = toggleBadgesBtn.getBoundingClientRect();
        const left = Math.max(12, buttonRect.right - 180);
        const top = buttonRect.bottom + 10;
        applyBadgePopoverPosition(left, top);
    } else {
        applyBadgePopoverPosition(badgePopoverPosition.left, badgePopoverPosition.top);
    }
}

function closeBadgeFilterPopover() {
    if (!badgeFilterPopover || !toggleBadgesBtn) return;
    badgeFilterPopover.setAttribute('hidden', '');
    toggleBadgesBtn.setAttribute('aria-expanded', 'false');
}

function openImportMenuPopover() {
    if (!importMenuPopover || !toggleImportMenuBtn) return;
    importMenuPopover.removeAttribute('hidden');
    toggleImportMenuBtn.setAttribute('aria-expanded', 'true');

    const buttonRect = toggleImportMenuBtn.getBoundingClientRect();
    importMenuPopover.style.left = `${Math.max(12, buttonRect.right - 220)}px`;
    importMenuPopover.style.top = `${buttonRect.bottom + 10}px`;
    importMenuPopover.style.right = 'auto';
}

function closeImportMenuPopover() {
    if (!importMenuPopover || !toggleImportMenuBtn) return;
    importMenuPopover.setAttribute('hidden', '');
    toggleImportMenuBtn.setAttribute('aria-expanded', 'false');
}

function setSectionCollapsed(toggleButton, content, collapsed) {
    if (!toggleButton || !content) return;
    toggleButton.setAttribute('aria-expanded', String(!collapsed));
    toggleButton.textContent = collapsed ? '▸' : '▾';
    content.hidden = collapsed;
}

function bindSectionCollapse(toggleButton, content, initiallyCollapsed = false) {
    if (!toggleButton || !content) return;
    setSectionCollapsed(toggleButton, content, initiallyCollapsed);
    toggleButton.addEventListener('click', () => {
        const isExpanded = toggleButton.getAttribute('aria-expanded') === 'true';
        setSectionCollapsed(toggleButton, content, isExpanded);
    });
}

function clampFloatingPopoverPosition(element, left, top) {
    if (!element) {
        return { left, top };
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rect = element.getBoundingClientRect();
    const maxLeft = Math.max(12, viewportWidth - rect.width - 12);
    const maxTop = Math.max(12, viewportHeight - rect.height - 12);

    return {
        left: Math.min(Math.max(12, left), maxLeft),
        top: Math.min(Math.max(12, top), maxTop)
    };
}

function applyTextPopoverPosition(left, top) {
    if (!textToolPopover) return;
    const next = clampFloatingPopoverPosition(textToolPopover, left, top);
    textPopoverPosition = next;
    textToolPopover.style.left = `${next.left}px`;
    textToolPopover.style.top = `${next.top}px`;
    textToolPopover.style.right = 'auto';
}

function openTextToolPopover() {
    if (!textToolPopover || !toggleTextToolBtn) return;
    textToolPopover.removeAttribute('hidden');
    toggleTextToolBtn.setAttribute('aria-expanded', 'true');

    if (!textPopoverPosition) {
        const buttonRect = toggleTextToolBtn.getBoundingClientRect();
        const left = Math.max(12, buttonRect.right - 260);
        const top = buttonRect.bottom + 10;
        applyTextPopoverPosition(left, top);
    } else {
        applyTextPopoverPosition(textPopoverPosition.left, textPopoverPosition.top);
    }
}

function closeTextToolPopover() {
    if (!textToolPopover || !toggleTextToolBtn) return;
    textToolPopover.setAttribute('hidden', '');
    toggleTextToolBtn.setAttribute('aria-expanded', 'false');
}

function applyDrawPopoverPosition(left, top) {
    if (!drawToolPopover) return;
    const next = clampFloatingPopoverPosition(drawToolPopover, left, top);
    drawPopoverPosition = next;
    drawToolPopover.style.left = `${next.left}px`;
    drawToolPopover.style.top = `${next.top}px`;
    drawToolPopover.style.right = 'auto';
}

function openDrawToolPopover() {
    if (!drawToolPopover || !toggleDrawToolBtn) return;
    drawToolPopover.removeAttribute('hidden');
    toggleDrawToolBtn.setAttribute('aria-expanded', 'true');

    if (!drawPopoverPosition) {
        const buttonRect = toggleDrawToolBtn.getBoundingClientRect();
        const left = Math.max(12, buttonRect.right - 260);
        const top = buttonRect.bottom + 10;
        applyDrawPopoverPosition(left, top);
    } else {
        applyDrawPopoverPosition(drawPopoverPosition.left, drawPopoverPosition.top);
    }
}

function closeDrawToolPopover() {
    if (!drawToolPopover || !toggleDrawToolBtn) return;
    drawToolPopover.setAttribute('hidden', '');
    toggleDrawToolBtn.setAttribute('aria-expanded', 'false');
}

function buildManualSitePopupHtml(site) {
    const analyzedPoint = state.processedPoints.find((point) => point.id === site.id);
    if (analyzedPoint) {
        return buildPointPopupHtml(analyzedPoint);
    }

    return `
      <b>${escapeHtml(site.name || site.displayName || site.id)}</b><br>
      Lat/Lon: ${roundTo(site.lat, 6)}, ${roundTo(site.lng, 6)}
    `;
}

function createManualSiteMarker(site) {
    const manualLabel = site.name || site.displayName || site.original?.['Site Name'] || site.id || 'Manual Site';
    const marker = L.marker([site.lat, site.lng], {
        draggable: true,
        icon: L.divIcon({
            className: 'manual-site-marker-icon',
            html: `
                <div class="manual-site-marker" style="cursor: grab;">
                    <span class="manual-site-marker__label">${escapeHtml(manualLabel)}</span>
                    <span class="manual-site-marker__square"></span>
                </div>
            `,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
            popupAnchor: [0, -34]
        })
    }).bindPopup(buildManualSitePopupHtml(site));

    marker.on('dragend', function (event) {
        const newLatLng = event.target.getLatLng();
        
        site.lat = newLatLng.lat;
        site.lng = newLatLng.lng;
        
        const pointObj = state.points.find(p => p.id === site.id);
        if (pointObj) {
            pointObj.lat = newLatLng.lat;
            pointObj.lng = newLatLng.lng;
            if (pointObj.original) {
                pointObj.original['Latitude'] = newLatLng.lat;
                pointObj.original['Longitude'] = newLatLng.lng;
            }
            
            // Re-analyze to update geo fields and UI
            analyzePoints().then(() => {
                // Focus point again to reopen popup and recenter if needed
                const processed = state.processedPoints.find(p => p.id === site.id);
                if (processed) {
                    focusPointOnMap(processed, { zoom: map.getZoom(), highlight: true });
                }
            });
        }
    });

    return marker;
}

function renderManualSites() {
    const group = state.mapLayerGroups.manualSites;
    group.clearLayers();

    state.manualSites.forEach((site) => {
        createManualSiteMarker(site).addTo(group);
    });
}

function formatRulerDistance(distanceMeters) {
    if (distanceMeters >= 1000) {
        return `${(distanceMeters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(distanceMeters)} m`;
}

function createRulerLabel(latlng, text) {
    return L.marker(latlng, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
            className: 'ruler-label',
            html: `<span class="ruler-label__text">${escapeHtml(text)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        })
    });
}

function createRulerPointMarker(latlng) {
    return L.marker(latlng, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
            className: 'ruler-point-marker',
            html: '<span class="ruler-point-marker__dot"></span>',
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        })
    });
}

function computeRulerMeasurementStats(points) {
    let totalMeters = 0;
    const segments = [];

    for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        const distanceMeters = map.distance(start, end);
        totalMeters += distanceMeters;
        segments.push({
            start,
            end,
            distanceMeters,
            midpoint: L.latLng(
                (start.lat + end.lat) / 2,
                (start.lng + end.lng) / 2
            )
        });
    }

    return { totalMeters, segments };
}

function getSelectedRulerMeasurement() {
    return state.ruler.measurements.find((measurement) => measurement.id === state.ruler.selectedId) || null;
}

function renderRulerMeasurements() {
    const group = state.mapLayerGroups.ruler;
    const handleGroup = state.mapLayerGroups.rulerHandles;
    group.clearLayers();
    handleGroup.clearLayers();

    const renderMeasurement = (measurement, isCurrent = false) => {
        const points = measurement.points;
        if (points.length === 0) return;

        points.forEach((latlng) => {
            createRulerPointMarker(latlng).addTo(group);
        });

        if (points.length >= 2) {
            const isSelected = !isCurrent && measurement.id === state.ruler.selectedId;
            const polyline = L.polyline(points, {
                color: isCurrent ? '#818cf8' : (isSelected ? '#60a5fa' : '#22c55e'),
                weight: 3,
                opacity: 0.95,
                dashArray: isCurrent ? '8 6' : null
            }).addTo(group);

            if (!isCurrent) {
                polyline.on('click', (event) => {
                    L.DomEvent.stopPropagation(event);
                    state.ruler.selectedId = measurement.id;
                    renderRulerMeasurements();
                });
            }

            const { segments } = computeRulerMeasurementStats(points);
            segments.forEach((segment) => {
                createRulerLabel(segment.midpoint, formatRulerDistance(segment.distanceMeters)).addTo(group);
            });

            if (isSelected) {
                createDrawingHandle(points[0], (latlng) => {
                    measurement.points[0] = latlng;
                    renderRulerMeasurements();
                }).addTo(handleGroup);

                createDrawingHandle(points[points.length - 1], (latlng) => {
                    measurement.points[measurement.points.length - 1] = latlng;
                    renderRulerMeasurements();
                }).addTo(handleGroup);
            }
        }
    };

    state.ruler.measurements.forEach((measurement) => {
        renderMeasurement(measurement, false);
    });

    if (state.ruler.currentPoints.length > 0) {
        renderMeasurement({ id: 'current-ruler-measurement', points: state.ruler.currentPoints }, true);
    }
}

function updateRulerControls() {
    if (!toggleRulerBtn) return;
    toggleRulerBtn.classList.toggle('active-tool', state.ruler.active);
    toggleRulerBtn.setAttribute('aria-pressed', String(state.ruler.active));
    toggleRulerBtn.textContent = state.ruler.active ? 'Ruler On' : 'Ruler';
}

function finalizeRulerMeasurement() {
    if (state.ruler.currentPoints.length >= 2) {
        const measurement = {
            id: `ruler-${Date.now()}`,
            points: [...state.ruler.currentPoints]
        };
        state.ruler.measurements.push(measurement);
        state.ruler.selectedId = measurement.id;
    }
    state.ruler.currentPoints = [];
    state.ruler.active = false;
    updateRulerControls();
    renderRulerMeasurements();
}

function getTextAnnotationDraft() {
    return {
        text: textAnnotationInput?.value.trim() || '',
        fontFamily: textAnnotationFont?.value || 'Outfit, sans-serif',
        fontSize: Number(textAnnotationSize?.value || 20),
        color: textAnnotationColor?.value || '#ffffff',
        opacity: Number(textAnnotationOpacity?.value || 1),
        useBackground: Boolean(textAnnotationUseBackground?.checked),
        backgroundColor: textAnnotationBgColor?.value || '#ef4444',
        backgroundOpacity: Number(textAnnotationBgOpacity?.value || 0.9)
    };
}

function getSelectedTextAnnotation() {
    return state.textAnnotations.find((annotation) => annotation.id === state.textTool.selectedId) || null;
}

function applyTextAnnotationDraftToControls(annotation) {
    if (!annotation) return;
    if (textAnnotationInput) textAnnotationInput.value = annotation.text || '';
    if (textAnnotationFont) textAnnotationFont.value = annotation.fontFamily || 'Outfit, sans-serif';
    if (textAnnotationSize) textAnnotationSize.value = String(annotation.fontSize || 20);
    if (textAnnotationColor) textAnnotationColor.value = annotation.color || '#ffffff';
    if (textAnnotationOpacity) textAnnotationOpacity.value = String(annotation.opacity ?? 1);
    if (textAnnotationUseBackground) textAnnotationUseBackground.checked = Boolean(annotation.useBackground);
    if (textAnnotationBgColor) textAnnotationBgColor.value = annotation.backgroundColor || '#ef4444';
    if (textAnnotationBgOpacity) textAnnotationBgOpacity.value = String(annotation.backgroundOpacity ?? 0.9);
}

function createTextAnnotationMarker(annotation, isSelected = false) {
    const background = annotation.useBackground
        ? `background:${hexToRgba(annotation.backgroundColor, annotation.backgroundOpacity)}; border: 1px solid rgba(255,255,255,0.16); padding:0.2rem 0.55rem; border-radius:999px;`
        : 'background:transparent; padding:0;';

    const marker = L.marker(annotation.latlng, {
        icon: L.divIcon({
            className: `text-annotation-marker${isSelected ? ' text-annotation-marker--selected' : ''}`,
            html: `
                <div class="text-annotation-marker__inner" style="
                    color:${escapeHtml(annotation.color)};
                    opacity:${annotation.opacity};
                    font-family:${escapeHtml(annotation.fontFamily)};
                    font-size:${annotation.fontSize}px;
                    ${background}
                ">${escapeHtml(annotation.text)}</div>
            `,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        })
    });

    marker.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        state.textTool.selectedId = annotation.id;
        state.textTool.placing = false;
        applyTextAnnotationDraftToControls(annotation);
        updateTextToolControls();
        renderTextAnnotations();
        openTextToolPopover();
    });

    return marker;
}

function renderTextAnnotations() {
    const group = state.mapLayerGroups.textAnnotations;
    group.clearLayers();

    state.textAnnotations.forEach((annotation) => {
        createTextAnnotationMarker(annotation, annotation.id === state.textTool.selectedId).addTo(group);
    });
}

function updateTextToolControls() {
    if (!toggleTextToolBtn) return;
    toggleTextToolBtn.classList.toggle('active-tool', state.textTool.placing);
    if (placeTextAnnotationBtn) {
        placeTextAnnotationBtn.textContent = state.textTool.placing
            ? 'Click On Map...'
            : (state.textTool.selectedId ? 'Save Changes' : 'Place On Map');
    }
    if (removeTextAnnotationBtn) removeTextAnnotationBtn.disabled = !state.textTool.selectedId;
}

function getSelectedDrawingAnnotation() {
    return state.draw.annotations.find((annotation) => annotation.id === state.draw.selectedId) || null;
}

function getDrawStyleTarget() {
    return getSelectedDrawingAnnotation()?.style || state.draw.defaultStyle;
}

function updateDrawToolControls() {
    const styleTarget = getDrawStyleTarget();

    if (toggleDrawToolBtn) {
        const isActive = Boolean(state.draw.mode);
        toggleDrawToolBtn.classList.toggle('active-tool', isActive);
        toggleDrawToolBtn.textContent = state.draw.mode ? `Draw: ${state.draw.mode}` : 'Draw';
    }

    const modeButtons = {
        dot: drawModeDotBtn,
        line: drawModeLineBtn,
        arrow: drawModeArrowBtn,
        rectangle: drawModeRectangleBtn,
        circle: drawModeCircleBtn
    };

    Object.entries(modeButtons).forEach(([mode, button]) => {
        if (!button) return;
        button.classList.toggle('active-tool', state.draw.mode === mode);
    });

    if (drawStrokeColor) drawStrokeColor.value = styleTarget.color;
    if (drawStrokeWidth) drawStrokeWidth.value = String(styleTarget.width);
    if (drawStrokeOpacity) drawStrokeOpacity.value = String(styleTarget.opacity);
    if (drawFillOpacity) drawFillOpacity.value = String(styleTarget.fillOpacity);
    if (drawDashedStroke) drawDashedStroke.checked = Boolean(styleTarget.dashed);
    if (removeSelectedDrawingBtn) removeSelectedDrawingBtn.disabled = !state.draw.selectedId;

    if (drawToolHint) {
        if (state.draw.mode === 'dot') {
            drawToolHint.textContent = 'Dot mode: click once on the map to place a dot.';
        } else if (state.draw.mode) {
            drawToolHint.textContent = `${state.draw.mode[0].toUpperCase()}${state.draw.mode.slice(1)} mode: click and drag on the map to draw. Select an existing line or shape to edit it.`;
        } else if (state.draw.selectedId) {
            drawToolHint.textContent = 'A drawing is selected. Drag its blue handles to edit its geometry, or change its style here.';
        } else {
            drawToolHint.textContent = 'Choose a mode, then draw on the map. Lines, arrows, rectangles, and circles use click-drag. Dots place on click.';
        }
    }
}

function createDrawingAnnotation(type, style, startLatLng, endLatLng = startLatLng) {
    return {
        id: `drawing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        start: startLatLng,
        end: endLatLng,
        style: { ...style }
    };
}

function getDrawDashArray(annotation) {
    return annotation.style.dashed ? '10 6' : null;
}

function getArrowHeadLatLngs(start, end, widthPx = 4) {
    const endPoint = map.latLngToContainerPoint(end);
    const startPoint = map.latLngToContainerPoint(start);
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) {
        return [end, end, end];
    }

    const ux = dx / length;
    const uy = dy / length;
    const headLength = Math.max(12, widthPx * 4);
    const headWidth = Math.max(8, widthPx * 2.4);

    const leftPoint = L.point(
        endPoint.x - ux * headLength - uy * headWidth * 0.5,
        endPoint.y - uy * headLength + ux * headWidth * 0.5
    );
    const rightPoint = L.point(
        endPoint.x - ux * headLength + uy * headWidth * 0.5,
        endPoint.y - uy * headLength - ux * headWidth * 0.5
    );

    return [
        map.containerPointToLatLng(leftPoint),
        end,
        map.containerPointToLatLng(rightPoint)
    ];
}

function createDrawingHandle(latlng, onDrag) {
    const marker = L.marker(latlng, {
        draggable: true,
        icon: L.divIcon({
            className: 'drawing-handle',
            html: '<span class="drawing-handle__dot"></span>',
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        })
    });
    marker.on('drag', (event) => {
        onDrag(event.target.getLatLng());
    });
    return marker;
}

function bindDrawingSelection(layer, annotation) {
    layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        state.draw.selectedId = annotation.id;
        updateDrawToolControls();
        renderDrawAnnotations();
        openDrawToolPopover();
    });
    return layer;
}

function createCircleFromAnnotation(annotation, isSelected) {
    const radiusMeters = map.distance(annotation.start, annotation.end);
    return bindDrawingSelection(L.circle(annotation.start, {
        radius: radiusMeters,
        color: annotation.style.color,
        weight: annotation.style.width,
        opacity: annotation.style.opacity,
        fillColor: annotation.style.color,
        fillOpacity: annotation.style.fillOpacity,
        dashArray: getDrawDashArray(annotation)
    }), annotation);
}

function createRectangleFromAnnotation(annotation, isSelected) {
    return bindDrawingSelection(L.rectangle(L.latLngBounds(annotation.start, annotation.end), {
        color: annotation.style.color,
        weight: annotation.style.width,
        opacity: annotation.style.opacity,
        fillColor: annotation.style.color,
        fillOpacity: annotation.style.fillOpacity,
        dashArray: getDrawDashArray(annotation)
    }), annotation);
}

function createLineLikeDrawing(annotation, isSelected) {
    const layers = [];
    const latlngs = [annotation.start, annotation.end];

    layers.push(bindDrawingSelection(L.polyline(latlngs, {
        color: annotation.style.color,
        weight: annotation.style.width,
        opacity: annotation.style.opacity,
        dashArray: getDrawDashArray(annotation)
    }), annotation));

    if (annotation.type === 'arrow') {
        layers.push(bindDrawingSelection(L.polygon(getArrowHeadLatLngs(annotation.start, annotation.end, annotation.style.width), {
            color: annotation.style.color,
            weight: Math.max(1, annotation.style.width * 0.4),
            opacity: annotation.style.opacity,
            fillColor: annotation.style.color,
            fillOpacity: annotation.style.opacity,
            dashArray: getDrawDashArray(annotation)
        }), annotation));
    }

    return layers;
}

function createDotDrawing(annotation, isSelected) {
    return bindDrawingSelection(L.circleMarker(annotation.start, {
        renderer: siteBddCanvasRenderer,
        radius: annotation.style.width,
        weight: Math.max(1, annotation.style.width * 0.3),
        color: annotation.style.color,
        opacity: annotation.style.opacity,
        fillColor: annotation.style.color,
        fillOpacity: annotation.style.fillOpacity
    }), annotation);
}

function renderDrawAnnotations() {
    const drawingGroup = state.mapLayerGroups.drawings;
    const handleGroup = state.mapLayerGroups.drawingHandles;
    drawingGroup.clearLayers();
    handleGroup.clearLayers();

    state.draw.annotations.forEach((annotation) => {
        const isSelected = annotation.id === state.draw.selectedId;
        if (annotation.type === 'dot') {
            createDotDrawing(annotation, isSelected).addTo(drawingGroup);
        } else if (annotation.type === 'rectangle') {
            createRectangleFromAnnotation(annotation, isSelected).addTo(drawingGroup);
        } else if (annotation.type === 'circle') {
            createCircleFromAnnotation(annotation, isSelected).addTo(drawingGroup);
        } else {
            createLineLikeDrawing(annotation, isSelected).forEach((layer) => layer.addTo(drawingGroup));
        }

        if (isSelected && annotation.type !== 'dot') {
            createDrawingHandle(annotation.start, (latlng) => {
                annotation.start = latlng;
                renderDrawAnnotations();
            }).addTo(handleGroup);
            createDrawingHandle(annotation.end, (latlng) => {
                annotation.end = latlng;
                renderDrawAnnotations();
            }).addTo(handleGroup);
        }

        if (isSelected && annotation.type === 'dot') {
            createDrawingHandle(annotation.start, (latlng) => {
                annotation.start = latlng;
                annotation.end = latlng;
                renderDrawAnnotations();
            }).addTo(handleGroup);
        }
    });

    if (state.draw.activeDraft) {
        const draft = state.draw.activeDraft;
        if (draft.type === 'dot') {
            createDotDrawing(draft, false).addTo(drawingGroup);
        } else if (draft.type === 'rectangle') {
            createRectangleFromAnnotation(draft, false).addTo(drawingGroup);
        } else if (draft.type === 'circle') {
            createCircleFromAnnotation(draft, false).addTo(drawingGroup);
        } else {
            createLineLikeDrawing(draft, false).forEach((layer) => layer.addTo(drawingGroup));
        }
    }
}

function syncDrawStyleFromControls() {
    const target = getDrawStyleTarget();
    if (!target) return;

    target.color = drawStrokeColor?.value || target.color;
    target.width = Number(drawStrokeWidth?.value || target.width);
    target.opacity = Number(drawStrokeOpacity?.value || target.opacity);
    target.fillOpacity = Number(drawFillOpacity?.value || target.fillOpacity);
    target.dashed = Boolean(drawDashedStroke?.checked);
}

function setDrawMode(mode) {
    state.ruler.active = false;
    state.ruler.currentPoints = [];
    state.ruler.selectedId = null;
    updateRulerControls();
    renderRulerMeasurements();
    state.textTool.placing = false;
    state.textTool.selectedId = null;
    updateTextToolControls();
    renderTextAnnotations();

    state.draw.mode = state.draw.mode === mode ? null : mode;
    state.draw.activeDraft = null;
    updateDrawToolControls();
    renderDrawAnnotations();
}

function finalizeActiveDrawing() {
    if (!state.draw.activeDraft) return;

    const draft = state.draw.activeDraft;
    state.draw.activeDraft = null;

    const distanceMeters = map.distance(draft.start, draft.end);
    if (draft.type !== 'dot' && distanceMeters < 1) {
        if (!map.dragging.enabled()) {
            map.dragging.enable();
        }
        renderDrawAnnotations();
        return;
    }

    state.draw.annotations.push(draft);
    state.draw.selectedId = draft.id;
    if (!map.dragging.enabled()) {
        map.dragging.enable();
    }
    updateDrawToolControls();
    renderDrawAnnotations();
}

function shouldIgnoreRulerPointerTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }

    return Boolean(target.closest('.leaflet-control, .leaflet-popup, .leaflet-tooltip'));
}

function addRulerPointFromMouseEvent(event) {
    if (!state.ruler.active || event.button !== 0 || shouldIgnoreRulerPointerTarget(event.target)) {
        return;
    }

    const mapContainer = map.getContainer();
    const rect = mapContainer.getBoundingClientRect();
    const containerPoint = L.point(
        event.clientX - rect.left,
        event.clientY - rect.top
    );
    const latlng = map.containerPointToLatLng(containerPoint);
    state.ruler.currentPoints.push(latlng);
    renderRulerMeasurements();
    event.preventDefault();
    event.stopPropagation();
}

function createPointMarker(point, popupHtml) {
    if (isManualAddedPoint(point)) {
        return createManualSiteMarker({
            ...point,
            name: point.displayName || point.original?.['Site Name'] || point.id
        }).bindPopup(popupHtml);
    }

    const networkLabel = getNetworkBadgeLabel(point);
    const marker = L.marker([point.lat, point.lng], {
        icon: L.divIcon({
            className: 'network-badge-icon',
            html: `<span class="network-badge ${getNetworkBadgeClass(networkLabel)}">${escapeHtml(networkLabel)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
            popupAnchor: [0, -22]
        })
    }).bindPopup(popupHtml);

    marker.on('click', () => {
        highlightTableRow(point.id);
    });

    return marker;
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

function setAuditFilter(filter) {
    state.auditFilter = filter;
    renderAuditFilterBar();
    renderComparisonReport();
    renderTable();
}

function clearAuditFilter() {
    setAuditFilter(null);
}

function renderAuditFilterBar() {
    if (!state.auditFilter) {
        auditFilterBar.style.display = 'none';
        auditFilterLabel.textContent = '';
        return;
    }

    auditFilterBar.style.display = 'flex';
    auditFilterLabel.textContent = state.auditFilter.label;
}

function isSameAuditFilter(a, b) {
    if (!a || !b) return false;
    if (a.type !== b.type) return false;
    if (a.type === 'count') {
        return a.field === b.field && a.valueKey === b.valueKey;
    }
    if (a.type === 'row') {
        return a.code === b.code && a.field === b.field;
    }
    return false;
}

function pointMatchesAuditFilter(point) {
    if (!state.auditFilter) return true;

    if (state.auditFilter.type === 'count') {
        const fieldConfig = COMPARISON_FIELDS.find((field) => field.label === state.auditFilter.field);
        if (!fieldConfig || !point._hasGeographyDivergence) return false;

        const originalValue = findOriginalFieldValue(point.original, fieldConfig.aliases);
        const calculatedValue = point[fieldConfig.computedKey];
        const originalKey = normalizeName(originalValue);
        const calculatedKey = normalizeName(calculatedValue);

        return (
            originalKey !== calculatedKey &&
            (originalKey === state.auditFilter.valueKey || calculatedKey === state.auditFilter.valueKey)
        );
    }

    if (state.auditFilter.type === 'row') {
        return String(point.original?.Code || point.id) === String(state.auditFilter.code);
    }

    return true;
}

function renderComparisonReport() {
    if (!comparisonGrid || !countDivergenceSummary || !rowDivergenceSummary || !countDivergenceTableBody || !rowDivergenceTableBody) {
        return;
    }

    const { countDifferences, rowDivergences } = state.comparisonReport;
    const pointByCode = new Map(
        state.processedPoints.map((point) => [String(point.original?.Code || point.id), point])
    );

    comparisonGrid.style.display = 'grid';
    countDivergenceSummary.textContent = `${countDifferences.length} count divergences between original geography and calculated geography.`;
    rowDivergenceSummary.textContent = `${rowDivergences.length} row-level divergences where original and calculated geography do not match.`;

    countDivergenceTableBody.innerHTML = '';
    if (countDifferences.length === 0) {
        countDivergenceTableBody.innerHTML = '<tr class="empty-state"><td colspan="5">No count divergences found.</td></tr>';
    } else {
        countDifferences.forEach((item) => {
            const row = document.createElement('tr');
            const rowFilter = {
                type: 'count',
                field: item.field,
                value: item.value,
                valueKey: normalizeName(item.value),
                label: `Audit filter: ${item.field} = ${item.value}`
            };
            row.className = 'audit-clickable-row';
            if (isSameAuditFilter(state.auditFilter, rowFilter)) {
                row.classList.add('active');
            }
            appendCell(row, item.field);
            appendCell(row, item.value);
            appendCell(row, item.originalCount);
            appendCell(row, item.calculatedCount);
            appendCell(row, `${item.difference > 0 ? '+' : ''}${item.difference}`);
            row.addEventListener('click', () => {
                if (isSameAuditFilter(state.auditFilter, rowFilter)) {
                    clearAuditFilter();
                    return;
                }
                setAuditFilter(rowFilter);
            });
            countDivergenceTableBody.appendChild(row);
        });
    }

    rowDivergenceTableBody.innerHTML = '';
    if (rowDivergences.length === 0) {
        rowDivergenceTableBody.innerHTML = '<tr class="empty-state"><td colspan="8">No row-level divergences found.</td></tr>';
    } else {
        rowDivergences.slice(0, 1000).forEach((item) => {
            const row = document.createElement('tr');
            const point = pointByCode.get(String(item.code));
            const rowFilter = {
                type: 'row',
                code: item.code,
                field: item.field,
                label: `Audit filter: ${item.code} (${item.field})`
            };
            row.className = 'audit-clickable-row';
            if (isSameAuditFilter(state.auditFilter, rowFilter)) {
                row.classList.add('active');
            }
            appendCell(row, item.code);
            appendCell(row, item.locality);
            appendCell(row, item.field);
            appendCell(row, item.original);
            appendCell(row, item.calculated);
            appendCell(row, item.nearestPlace ? `${item.nearestPlace} (${formatDistanceKm(item.nearestPlaceDistanceKm)} km)` : '-');
            appendCell(row, item.inhabitedArea ? `${item.inhabitedArea}${item.isInsideInhabitedArea ? '' : ` (${formatDistanceKm(item.inhabitedAreaDistanceKm)} km)`}` : '-');
            const riskCell = appendCell(row, point ? '' : '-');
            if (point) {
                riskCell.textContent = '';
                riskCell.appendChild(createRiskPillElement(point));
            }
            row.addEventListener('click', () => {
                setAuditFilter(rowFilter);

                const foundPoint = state.processedPoints.find((point) => String(point.original?.Code || point.id) === String(item.code));
                if (foundPoint) {
                    focusPointOnMap(foundPoint, { zoom: 12 });
                }
            });
            rowDivergenceTableBody.appendChild(row);
        });
    }
}

function getActiveHierarchyFilter() {
    const communes = [...hierarchy.visible.communes];
    if (communes.length > 0) {
        return {
            type: 'commune',
            allowed: new Set(communes.map(normalizeName))
        };
    }

    const provinces = [...hierarchy.visible.provinces];
    if (provinces.length > 0) {
        return {
            type: 'province',
            allowed: new Set(provinces.map(normalizeName))
        };
    }

    const drs = [...hierarchy.visible.drs];
    if (drs.length > 0) {
        return {
            type: 'dr',
            allowed: new Set(drs.map(normalizeName))
        };
    }

    const regions = [...hierarchy.visible.regions];
    if (regions.length > 0) {
        return {
            type: 'region',
            allowed: new Set(regions.map(normalizeName))
        };
    }

    return null;
}

function getFilteredPoints() {
    const showOnlyEmptySS = filterEmptySS.checked;
    const showOnlyGeographyDivergence = filterGeographyDivergence.checked;
    const showOnlyHighRisk = filterHighRisk.checked;
    const hierarchyFilter = getActiveHierarchyFilter();

    return state.processedPoints.filter(p => {
        if (showOnlyEmptySS && !p._isEmptySS) return false;
        if (showOnlyGeographyDivergence && !p._hasGeographyDivergence) return false;
        if (showOnlyHighRisk && (p.reviewRiskScore || 0) < HIGH_RISK_THRESHOLD) return false;
        if (!pointMatchesAuditFilter(p)) return false;

        if (!hierarchyFilter) return true;

        if (hierarchyFilter.type === 'commune') {
            return hierarchyFilter.allowed.has(normalizeName(p.commune));
        }

        if (hierarchyFilter.type === 'province') {
            return hierarchyFilter.allowed.has(normalizeName(p.province));
        }

        if (hierarchyFilter.type === 'dr') {
            return hierarchyFilter.allowed.has(normalizeName(p.dr));
        }

        if (hierarchyFilter.type === 'region') {
            return hierarchyFilter.allowed.has(normalizeName(p.region));
        }

        return true;
    });
}

function schedulePointMarkerRender() {
    if (markerRenderFrame !== null) {
        cancelAnimationFrame(markerRenderFrame);
    }

    markerRenderFrame = requestAnimationFrame(() => {
        markerRenderFrame = null;
        renderVisiblePointMarkers();
    });
}

function renderVisiblePointMarkers() {
    state.mapLayerGroups.points.clearLayers();

    if (!state.filteredPoints.length) {
        return;
    }

    if (map.getZoom() < BADGE_MIN_ZOOM) {
        return;
    }

    const bounds = map.getBounds().pad(0.2);
    const visiblePoints = state.filteredPoints.filter((point) => {
        if (!bounds.contains([point.lat, point.lng])) {
            return false;
        }
        if (isManualAddedPoint(point)) {
            return false;
        }
        return state.visibleNetworkBadges.has(getNetworkBadgeLabel(point));
    });

    visiblePoints.forEach((point) => {
        createPointMarker(point, buildPointPopupHtml(point)).addTo(state.mapLayerGroups.points);
    });
}

function buildPointPopupHtml(point) {
    return `
      <b>${escapeHtml(point.displayName || point.id)}</b><br>
      Code: ${escapeHtml(point.id)}<br>
      Network: ${escapeHtml(getNetworkBadgeLabel(point))}<br>
      Locality Match: ${escapeHtml(formatLocalityReferenceLabel(point))}${point.localityReferenceName ? ` (${formatDistanceKm(point.localityReferenceDistanceKm)} km)` : ''}<br>
      Nearest Place: ${escapeHtml(formatNearestPlaceLabel(point))}${point.nearestPlaceName ? ` (${formatDistanceKm(point.nearestPlaceDistanceKm)} km)` : ''}<br>
      Inhabited Area: ${escapeHtml(formatInhabitedAreaLabel(point))}<br>
      Inside inhabited area: ${point.isInsideInhabitedArea ? 'Yes' : 'No'}<br>
      Review Risk: ${point.reviewRiskLevel || 'Low'} (${Math.round(point.reviewRiskScore || 0)}/100)<br>
      Commune: ${escapeHtml(point.commune)}<br>
      Province: ${escapeHtml(point.province)}<br>
      Region: ${escapeHtml(point.region)}<br>
      ${point._isEmptySS ? '<b style="color:orange">Missing SS Data</b>' : ''}
    `;
}

function buildExportRows(points) {
    return points.map((p) => ({
        ...p.original,
        'Display_Name': p.displayName || p.id,
        'Normalized_Latitude': p.lat,
        'Normalized_Longitude': p.lng,
        'Locality_Name_Match': p.localityReferenceName || '',
        'Locality_Name_Match_Distance_Km': Number.isFinite(p.localityReferenceDistanceKm) ? Number(p.localityReferenceDistanceKm.toFixed(3)) : '',
        'Locality_Name_Match_Class': p.localityReferenceClass || '',
        'Locality_Name_Match_Exact': p.localityReferenceExactMatch ? 'Yes' : 'No',
        'Locality_Name_Match_Note': p.localityReferenceName && !p.localityReferenceExactMatch ? 'not matched 100%' : '',
        'Locality_Name_Match_Source': p.localityReferenceSource || '',
        'Locality_Name_Match_Url': p.localityReferenceUrl || '',
        'Nearest_Place': p.nearestPlaceName || '',
        'Nearest_Place_Distance_Km': Number.isFinite(p.nearestPlaceDistanceKm) ? Number(p.nearestPlaceDistanceKm.toFixed(3)) : '',
        'Nearest_Place_Class': p.nearestPlaceClass || '',
        'Inside_Inhabited_Area': p.isInsideInhabitedArea ? 'Yes' : 'No',
        'Inhabited_Area': p.inhabitedAreaName || '',
        'Inhabited_Area_Class': p.inhabitedAreaClass || '',
        'Nearest_Inhabited_Area': p.nearestInhabitedAreaName || '',
        'Nearest_Inhabited_Area_Distance_Km': Number.isFinite(p.nearestInhabitedAreaDistanceKm) ? Number(p.nearestInhabitedAreaDistanceKm.toFixed(3)) : '',
        'Nearest_Inhabited_Area_Class': p.nearestInhabitedAreaClass || '',
        'Review_Risk_Score': Number.isFinite(p.reviewRiskScore) ? Math.round(p.reviewRiskScore) : '',
        'Review_Risk_Level': p.reviewRiskLevel || '',
        'Review_Risk_Reasons': Array.isArray(p.reviewRiskReasons) ? p.reviewRiskReasons.join(' | ') : '',
        'Normalization_Action': p.normalization?.normalizationAction || '',
        'Normalization_Confidence': p.normalization?.normalizationConfidence || '',
        'Auto_Commune': p.commune,
        'Auto_Province': p.province,
        'Auto_Region': p.region,
        'Coverage_2G': p['2G'],
        'Coverage_3G': p['3G'],
        'Coverage_4G': p['4G'],
        'Emergency_141': p['141'],
        'Emergency_5757': p['5757'],
        'Emergency_15': p['15'],
        'Emergency_19': p['19'],
        'Emergency_112': p['112'],
        'Emergency_177': p['177']
    }));
}

function buildDisplayedTableExportRows(points) {
    const headers = [
        'Site Name',
        'Latitude',
        'Longitude',
        'Matched Localité',
        'Distance (km)',
        'Nearest Place',
        'Distance (km)',
        'Calculated Commune',
        'Calculated Province',
        'Calculated Region',
        'Calculated DR',
        'Code',
        'Provice',
        'Commune',
        'Localité',
        'Sous-Localité',
        'Réseaux mobiles Voix et Data (2G ou 2G/3G ou 2G/3G/4G)'
    ];

    const rows = points.map((p) => {
        const sourceCode = p.original?.Code || p.id || '-';
        const sourceProvince = p.original?.Province || '-';
        const sourceCommune = p.original?.Commune || '-';
        const sourceLocality = p.original?.Localite || '-';
        const sourceSubLocality = p.original?.SousLocalite || '-';
        const sourceNetwork = p.original?.DeclarationIAM || '-';
        const localityReferenceLabel = p.localityReferenceName || '-';
        const localityReferenceDistance = Number.isFinite(p.localityReferenceDistanceKm) ? formatDistanceKm(p.localityReferenceDistanceKm) : '-';
        const nearestPlaceLabel = formatNearestPlaceLabel(p);
        const nearestPlaceDistance = Number.isFinite(p.nearestPlaceDistanceKm) ? formatDistanceKm(p.nearestPlaceDistanceKm) : '-';

        return [
            p.displayName || p.id,
            p.lat.toFixed(5),
            p.lng.toFixed(5),
            localityReferenceLabel,
            localityReferenceDistance,
            nearestPlaceLabel,
            nearestPlaceDistance,
            p.commune,
            p.province,
            p.region,
            p.dr,
            sourceCode,
            sourceProvince,
            sourceCommune,
            sourceLocality,
            sourceSubLocality,
            sourceNetwork
        ];
    });

    return [headers, ...rows];
}

function clearFocusOverlays() {
    state.mapLayerGroups.focus.clearLayers();
}

function addFocusCircle(lat, lng, label, color) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    L.circle([lat, lng], {
        radius: 700,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.08
    })
        .bindTooltip(label, {
            permanent: false,
            direction: 'top',
            opacity: 0.95
        })
        .addTo(state.mapLayerGroups.focus);
}

function focusPointOnMap(point, { zoom = 15, highlight = true } = {}) {
    if (!point) return;

    state.activePointId = point.id;
    clearFocusOverlays();

    const focusCoords = [[point.lat, point.lng]];

    if (Number.isFinite(point.localityReferenceLat) && Number.isFinite(point.localityReferenceLng)) {
        if (filterFocusCircles?.checked) {
            addFocusCircle(
                point.localityReferenceLat,
                point.localityReferenceLng,
                `Matched Localite: ${point.localityReferenceName || 'Reference place'}`,
                '#10b981'
            );
        }
        focusCoords.push([point.localityReferenceLat, point.localityReferenceLng]);
    }

    if (Number.isFinite(point.nearestPlaceLat) && Number.isFinite(point.nearestPlaceLng)) {
        if (filterFocusCircles?.checked) {
            addFocusCircle(
                point.nearestPlaceLat,
                point.nearestPlaceLng,
                `Nearest Place: ${point.nearestPlaceName || 'Nearest place'}`,
                '#f59e0b'
            );
        }
        focusCoords.push([point.nearestPlaceLat, point.nearestPlaceLng]);
    }

    if (focusCoords.length > 1) {
        map.fitBounds(L.latLngBounds(focusCoords), { padding: [80, 80], maxZoom: Math.max(map.getZoom(), zoom) });
    } else {
        map.flyTo([point.lat, point.lng], Math.max(map.getZoom(), zoom));
    }

    setTimeout(() => {
        schedulePointMarkerRender();
        L.popup()
            .setLatLng([point.lat, point.lng])
            .setContent(buildPointPopupHtml(point))
            .openOn(map);

        if (highlight) {
            highlightTableRow(point.id);
        }
    }, 250);
}

function createRow(p) {
    const sourceCode = p.original?.Code || p.id || '-';
    const sourceProvince = p.original?.Province || '-';
    const sourceCommune = p.original?.Commune || '-';
    const sourceLocality = p.original?.Localite || '-';
    const sourceSubLocality = p.original?.SousLocalite || '-';
    const sourceNetwork = p.original?.DeclarationIAM || '-';
    const localityReferenceLabel = formatLocalityReferenceLabel(p);
    const localityReferenceDistance = Number.isFinite(p.localityReferenceDistanceKm) ? formatDistanceKm(p.localityReferenceDistanceKm) : '-';
    const nearestPlaceLabel = formatNearestPlaceLabel(p);
    const nearestPlaceDistance = Number.isFinite(p.nearestPlaceDistanceKm) ? formatDistanceKm(p.nearestPlaceDistanceKm) : '-';

    const row = document.createElement('tr');
    row.id = `row-${p.id}`;
    if (p._hasGeographyDivergence) {
        row.classList.add('divergence-row');
    }
    if (p.reviewRiskLevel === 'High') {
        row.classList.add('high-risk-row');
    }
    row.classList.add('result-clickable-row');
    row.title = 'Click to zoom to this site on the map';
    appendCell(row, `${p.displayName || p.id}${p._hasGeographyDivergence ? ' *' : ''}`, { title: p._hasGeographyDivergence ? `Geography divergence: ${p._divergenceFields.join(', ')}` : '' });
    appendCell(row, p.lat.toFixed(5));
    appendCell(row, p.lng.toFixed(5));
    appendCell(row, localityReferenceLabel);
    appendCell(row, localityReferenceDistance);
    appendCell(row, nearestPlaceLabel);
    appendCell(row, nearestPlaceDistance);
    appendCell(row, p.commune, { className: p.commune !== 'N/A' ? '' : 'text-muted' });
    appendCell(row, p.province, { className: p.province !== 'N/A' ? '' : 'text-muted' });
    appendCell(row, p.region, { className: p.region !== 'N/A' ? '' : 'text-muted' });
    appendCell(row, p.dr, { className: p.dr !== 'N/A' ? '' : 'text-muted' });
    appendCell(row, sourceCode);
    appendCell(row, sourceProvince);
    appendCell(row, sourceCommune);
    appendCell(row, sourceLocality);
    appendCell(row, sourceSubLocality);
    appendCell(row, sourceNetwork);
    row.addEventListener('click', () => {
        focusPointOnMap(p);
    });
    return row;
}

function highlightTableRow(id) {
    let row = document.getElementById(`row-${id}`);

    // If row not found (e.g. outside of 500 limit), try to find point and add it
    if (!row) {
        const point = state.processedPoints.find(p => p.id == id); // Loose equality for string/number match
        if (point) {
            row = createRow(point);
            resultsTableBody.appendChild(row);
        }
    }

    if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('highlight-row');
        setTimeout(() => row.classList.remove('highlight-row'), 3000);
    } else {
        console.log("Row not found for id:", id);
    }
}

// --- Analysis Logic ---
function analyzePoints() {
    if (!areGeoLayersReady()) {
        updateStatus(false);
        alert('Geographic layers are not ready yet, so the points cannot be analyzed. Please try again once the map data has finished loading.');
        return Promise.resolve(null);
    }

    state.mapLayerGroups.points.clearLayers();
    state.processedPoints = [];
    state.filteredPoints = [];
    state.auditFilter = null;
    renderAuditFilterBar();
    state.comparisonReport = {
        countDifferences: [],
        rowDivergences: []
    };

    // Reset stats
    updateStats(state.points.length, 0, 0);

    // Disable export during processing
    exportBtn.disabled = true;
    exportDisplayedBtn.disabled = true;

    return ensureAnalysisWorker()
        .then((worker) => new Promise((resolve, reject) => {
            const requestId = ++analysisRequestCounter;
            const handleMessage = (event) => {
                const message = event.data || {};
                if (message.requestId !== requestId) {
                    return;
                }

                if (message.type === 'progress') {
                    const { processedCount, total, matchedCount, emptySSCount } = message.payload;
                    updateStatus(true, `Processed ${processedCount} / ${total} points...`);
                    updateStats(total, matchedCount, emptySSCount);
                    return;
                }

                cleanup();

                if (message.type === 'complete') {
                    finishAnalysis(message.payload);
                    resolve(message.payload);
                    return;
                }

                if (message.type === 'error') {
                    reject(new Error(message.error || 'Unknown worker error'));
                }
            };

            const handleError = (error) => {
                cleanup();
                reject(error instanceof Error ? error : new Error('Analysis worker crashed.'));
            };

            const cleanup = () => {
                worker.removeEventListener('message', handleMessage);
                worker.removeEventListener('error', handleError);
            };

            worker.addEventListener('message', handleMessage);
            worker.addEventListener('error', handleError);
            worker.postMessage({
                type: 'analyze',
                requestId,
                payload: {
                    points: state.points,
                    localityReferenceOverrides: Array.from(
                        state.localityReferenceOverrides.entries(),
                        ([id, override]) => [String(id), override]
                    )
                }
            });
        }))
        .catch((error) => {
            console.error(error);
            resetAnalysisWorker();
            updateStatus(false);
            exportBtn.disabled = false;
            exportDisplayedBtn.disabled = false;
            alert(`Error analyzing points: ${error.message}`);
            return null;
        });
}

function finishAnalysis(analysisResult) {
    const {
        processedPoints = [],
        comparisonReport = { countDifferences: [], rowDivergences: [] },
        matchedCount = 0,
        emptySSCount = 0
    } = analysisResult || {};

    state.processedPoints = processedPoints;
    state.comparisonReport = comparisonReport;
    updateStats(state.points.length, matchedCount, emptySSCount);
    renderTable();
    renderManualSites();
    renderComparisonReport();
    renderRegions();
    renderDRs();
    renderProvinces();
    renderCommunes();
    updateStatus(false);
    filtersCard.style.display = 'block';

    exportBtn.disabled = false;
    exportDisplayedBtn.disabled = false;
}

// --- UI Updates ---
function updateStatus(show, text = '') {
    statusBox.style.display = show ? 'flex' : 'none';
    statusText.textContent = text;
}

function updateStats(total, matched, emptySS) {
    // statsCard.style.display = 'block';
    totalPointsEl.textContent = total;
    matchedPointsEl.textContent = matched;
    emptySSPointsEl.textContent = emptySS;
}

function updateLegend() {
    if (!drLegend) return;

    drLegend.innerHTML = '';
    let hasContent = false;

    const appendSection = (titleText, items) => {
        if (!items.length) return;
        if (hasContent) {
            const separator = document.createElement('hr');
            separator.style.margin = '10px 0';
            separator.style.border = '0';
            separator.style.borderTop = '1px solid rgba(255,255,255,0.1)';
            drLegend.appendChild(separator);
        }

        hasContent = true;
        const section = document.createElement('div');
        const title = document.createElement('h4');
        title.textContent = titleText;
        section.appendChild(title);
        drLegend.appendChild(section);

        items.forEach(({ color, label }) => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            const swatch = document.createElement('div');
            swatch.className = 'legend-color';
            swatch.style.background = color;
            const text = document.createElement('span');
            text.textContent = label;
            item.appendChild(swatch);
            item.appendChild(text);
            drLegend.appendChild(item);
        });
    };

    if (toggleRegions?.checked) {
        appendSection('Regions', Object.keys(state.regionColors).map((name) => ({
            color: state.regionColors[name],
            label: name
        })));
    }

    if (toggleDRs?.checked) {
        appendSection('Directions Régionales', Object.keys(state.drColors).map((name) => ({
            color: state.drColors[name],
            label: name
        })));
    }

    if (state.siteBdd.imported) {
        const visibleSiteBdds = getSiteBddRenderOrder()
            .filter((tech) => state.siteBdd.datasets[tech].visible)
            .map((tech) => ({
                color: state.siteBdd.datasets[tech].color,
                label: state.siteBdd.datasets[tech].label
            }));
        appendSection(state.siteBdd.legendName || 'Sites IAM', visibleSiteBdds);
    }

    if (state.customSiteOverlays.length) {
        const visibleCustomOverlays = state.customSiteOverlays
            .filter((overlay) => overlay.visible)
            .map((overlay) => ({
                color: overlay.color,
                label: (overlay.legendName || overlay.label || 'Overlay').trim() || overlay.label || 'Overlay'
            }));
        appendSection('KML / KMZ Overlays', visibleCustomOverlays);
    }

    drLegend.style.display = hasContent ? 'block' : 'none';
}

function renderTable() {
    resultsTableBody.innerHTML = '';
    state.filteredPoints = getFilteredPoints();
    schedulePointMarkerRender();

    // Show first 500 of filtered list
    const displayPoints = state.filteredPoints.slice(0, 500);

    if (displayPoints.length === 0) {
        resultsTableBody.innerHTML = '<tr class="empty-state"><td colspan="17">No rows match the current filters.</td></tr>';
        return;
    }

    displayPoints.forEach(p => {
        const row = createRow(p);
        resultsTableBody.appendChild(row);
    });
}

filterEmptySS.addEventListener('change', () => {
    renderTable();
});

filterGeographyDivergence.addEventListener('change', () => {
    renderTable();
});

filterHighRisk.addEventListener('change', () => {
    renderTable();
});

filterFocusCircles?.addEventListener('change', () => {
    if (state.activePointId) {
        const point = state.processedPoints.find(p => p.id === state.activePointId);
        if (point) {
            clearFocusOverlays();
            if (filterFocusCircles.checked) {
                if (Number.isFinite(point.localityReferenceLat) && Number.isFinite(point.localityReferenceLng)) {
                    addFocusCircle(
                        point.localityReferenceLat,
                        point.localityReferenceLng,
                        `Matched Localite: ${point.localityReferenceName || 'Reference place'}`,
                        '#10b981'
                    );
                }
                if (Number.isFinite(point.nearestPlaceLat) && Number.isFinite(point.nearestPlaceLng)) {
                    addFocusCircle(
                        point.nearestPlaceLat,
                        point.nearestPlaceLng,
                        `Nearest Place: ${point.nearestPlaceName || 'Nearest place'}`,
                        '#f59e0b'
                    );
                }
            }
        }
    }
});

clearAuditFilterBtn.addEventListener('click', () => {
    clearAuditFilter();
});

toggleBadgesBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!badgeFilterPopover) return;
    if (badgeFilterPopover.hasAttribute('hidden')) {
        openBadgeFilterPopover();
    } else {
        closeBadgeFilterPopover();
    }
});

badgeFilterPopover?.addEventListener('click', (event) => {
    event.stopPropagation();
});

badgeFilterPopoverHeader?.addEventListener('mousedown', (event) => {
    if (!badgeFilterPopover) return;
    event.preventDefault();

    const rect = badgeFilterPopover.getBoundingClientRect();
    badgePopoverDragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
    };
});

toggleRulerBtn?.addEventListener('click', () => {
    if (state.ruler.active) {
        finalizeRulerMeasurement();
        return;
    }
    state.draw.mode = null;
    state.draw.activeDraft = null;
    state.draw.selectedId = null;
    updateDrawToolControls();
    renderDrawAnnotations();
    state.textTool.placing = false;
    state.textTool.selectedId = null;
    updateTextToolControls();
    renderTextAnnotations();
    state.ruler.active = true;
    state.ruler.currentPoints = [];
    state.ruler.selectedId = null;
    updateRulerControls();
    renderRulerMeasurements();
});

clearRulerBtn?.addEventListener('click', () => {
    state.ruler.active = false;
    state.ruler.currentPoints = [];
    state.ruler.selectedId = null;
    state.ruler.measurements = [];
    updateRulerControls();
    renderRulerMeasurements();
});

toggleTextToolBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.draw.mode = null;
    state.draw.activeDraft = null;
    updateDrawToolControls();
    renderDrawAnnotations();
    if (!textToolPopover) return;
    if (textToolPopover.hasAttribute('hidden')) {
        openTextToolPopover();
    } else {
        closeTextToolPopover();
    }
});

textToolPopover?.addEventListener('click', (event) => {
    event.stopPropagation();
});

textToolPopoverHeader?.addEventListener('mousedown', (event) => {
    if (!textToolPopover) return;
    event.preventDefault();

    const rect = textToolPopover.getBoundingClientRect();
    textPopoverDragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
    };
});

placeTextAnnotationBtn?.addEventListener('click', () => {
    if (!textAnnotationInput?.value.trim()) {
        alert('Please enter some text first.');
        return;
    }

    const selectedAnnotation = getSelectedTextAnnotation();
    if (selectedAnnotation && !state.textTool.placing) {
        Object.assign(selectedAnnotation, getTextAnnotationDraft());
        updateTextToolControls();
        renderTextAnnotations();
        return;
    }

    state.draw.mode = null;
    state.draw.activeDraft = null;
    state.draw.selectedId = null;
    updateDrawToolControls();
    renderDrawAnnotations();
    state.ruler.active = false;
    state.ruler.currentPoints = [];
    state.ruler.selectedId = null;
    updateRulerControls();
    renderRulerMeasurements();
    state.textTool.selectedId = null;
    state.textTool.placing = true;
    updateTextToolControls();
});

removeTextAnnotationBtn?.addEventListener('click', () => {
    if (!state.textTool.selectedId) return;
    state.textAnnotations = state.textAnnotations.filter((annotation) => annotation.id !== state.textTool.selectedId);
    state.textTool.selectedId = null;
    state.textTool.placing = false;
    updateTextToolControls();
    renderTextAnnotations();
});

clearTextAnnotationsBtn?.addEventListener('click', () => {
    state.textTool.placing = false;
    state.textTool.selectedId = null;
    updateTextToolControls();
    state.textAnnotations = [];
    renderTextAnnotations();
});

toggleDrawToolBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!drawToolPopover) return;
    if (drawToolPopover.hasAttribute('hidden')) {
        openDrawToolPopover();
    } else {
        closeDrawToolPopover();
    }
});

drawToolPopover?.addEventListener('click', (event) => {
    event.stopPropagation();
});

drawToolPopoverHeader?.addEventListener('mousedown', (event) => {
    if (!drawToolPopover) return;
    event.preventDefault();
    const rect = drawToolPopover.getBoundingClientRect();
    drawPopoverDragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
    };
});

drLegend?.addEventListener('mousedown', (event) => {
    event.preventDefault();
    legendDragState = {
        startX: event.clientX,
        startY: event.clientY,
        startLeft: drLegend.offsetLeft,
        startTop: drLegend.offsetTop
    };
});

drawModeDotBtn?.addEventListener('click', () => setDrawMode('dot'));
drawModeLineBtn?.addEventListener('click', () => setDrawMode('line'));
drawModeArrowBtn?.addEventListener('click', () => setDrawMode('arrow'));
drawModeRectangleBtn?.addEventListener('click', () => setDrawMode('rectangle'));
drawModeCircleBtn?.addEventListener('click', () => setDrawMode('circle'));

[drawStrokeColor, drawStrokeWidth, drawStrokeOpacity, drawFillOpacity, drawDashedStroke].forEach((control) => {
    control?.addEventListener('input', () => {
        syncDrawStyleFromControls();
        updateDrawToolControls();
        renderDrawAnnotations();
    });
});

stopDrawingBtn?.addEventListener('click', () => {
    state.draw.mode = null;
    state.draw.activeDraft = null;
    updateDrawToolControls();
    renderDrawAnnotations();
});

removeSelectedDrawingBtn?.addEventListener('click', () => {
    if (!state.draw.selectedId) return;
    state.draw.annotations = state.draw.annotations.filter((annotation) => annotation.id !== state.draw.selectedId);
    state.draw.selectedId = null;
    updateDrawToolControls();
    renderDrawAnnotations();
});

clearDrawingsBtn?.addEventListener('click', () => {
    state.draw.mode = null;
    state.draw.activeDraft = null;
    state.draw.selectedId = null;
    state.draw.annotations = [];
    updateDrawToolControls();
    renderDrawAnnotations();
});

Object.entries(networkBadgeControls).forEach(([label, control]) => {
    control?.addEventListener('change', (event) => {
        if (event.target.checked) {
            state.visibleNetworkBadges.add(label);
        } else {
            state.visibleNetworkBadges.delete(label);
        }
        updateNetworkBadgeControls();
        schedulePointMarkerRender();
    });
});

document.addEventListener('click', (event) => {
    if (importMenuPopover && toggleImportMenuBtn && !importMenuPopover.hasAttribute('hidden')) {
        if (!importMenuPopover.contains(event.target) && !toggleImportMenuBtn.contains(event.target)) {
            closeImportMenuPopover();
        }
    }

    if (badgeFilterPopover && toggleBadgesBtn && !badgeFilterPopover.hasAttribute('hidden')) {
        if (!badgeFilterPopover.contains(event.target) && !toggleBadgesBtn.contains(event.target)) {
            closeBadgeFilterPopover();
        }
    }

    if (textToolPopover && toggleTextToolBtn && !textToolPopover.hasAttribute('hidden')) {
        if (!textToolPopover.contains(event.target) && !toggleTextToolBtn.contains(event.target)) {
            closeTextToolPopover();
        }
    }

    if (drawToolPopover && toggleDrawToolBtn && !drawToolPopover.hasAttribute('hidden')) {
        if (!drawToolPopover.contains(event.target) && !toggleDrawToolBtn.contains(event.target)) {
            closeDrawToolPopover();
        }
    }
});

document.addEventListener('mousemove', (event) => {
    if (badgePopoverDragState) {
        applyBadgePopoverPosition(
            event.clientX - badgePopoverDragState.offsetX,
            event.clientY - badgePopoverDragState.offsetY
        );
    }

    if (textPopoverDragState) {
        applyTextPopoverPosition(
            event.clientX - textPopoverDragState.offsetX,
            event.clientY - textPopoverDragState.offsetY
        );
    }

    if (drawPopoverDragState) {
        applyDrawPopoverPosition(
            event.clientX - drawPopoverDragState.offsetX,
            event.clientY - drawPopoverDragState.offsetY
        );
    }

    if (legendDragState) {
        applyLegendPosition(
            legendDragState.startLeft + (event.clientX - legendDragState.startX),
            legendDragState.startTop + (event.clientY - legendDragState.startY)
        );
    }
});

document.addEventListener('mouseup', () => {
    badgePopoverDragState = null;
    textPopoverDragState = null;
    drawPopoverDragState = null;
    legendDragState = null;
    finalizeActiveDrawing();
});

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    if (state.textTool.placing) {
        state.textTool.placing = false;
        updateTextToolControls();
    }

    if (state.ruler.active) {
        finalizeRulerMeasurement();
    }

    if (state.draw.activeDraft) {
        state.draw.activeDraft = null;
        if (!map.dragging.enabled()) {
            map.dragging.enable();
        }
        updateDrawToolControls();
        renderDrawAnnotations();
    }
});

window.addEventListener('resize', () => {
    if (badgePopoverPosition && badgeFilterPopover && !badgeFilterPopover.hasAttribute('hidden')) {
        applyBadgePopoverPosition(badgePopoverPosition.left, badgePopoverPosition.top);
    }
    if (textPopoverPosition && textToolPopover && !textToolPopover.hasAttribute('hidden')) {
        applyTextPopoverPosition(textPopoverPosition.left, textPopoverPosition.top);
    }
    if (drawPopoverPosition && drawToolPopover && !drawToolPopover.hasAttribute('hidden')) {
        applyDrawPopoverPosition(drawPopoverPosition.left, drawPopoverPosition.top);
    }
    if (legendPosition && drLegend && drLegend.style.display !== 'none') {
        applyLegendPosition(legendPosition.left, legendPosition.top);
    }
});

Object.entries(siteBddControls).forEach(([tech, controls]) => {
    controls.toggle?.addEventListener('change', (event) => {
        state.siteBdd.datasets[tech].visible = event.target.checked;
        renderSiteBddLayers();
    });

    controls.moveUp?.addEventListener('click', () => {
        moveSiteBddLayer(tech, -1);
    });

    controls.moveDown?.addEventListener('click', () => {
        moveSiteBddLayer(tech, 1);
    });

    controls.settingsToggle?.addEventListener('click', () => {
        state.siteBdd.datasets[tech].settingsOpen = !state.siteBdd.datasets[tech].settingsOpen;
        updateSiteBddControls();
    });

    controls.color?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].color = event.target.value;
        renderSiteBddLayers();
    });

    controls.showNames?.addEventListener('change', (event) => {
        state.siteBdd.datasets[tech].showSiteNames = event.target.checked;
        renderSiteBddLayers();
    });

    controls.siteSizeInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.siteRadius = Number(event.target.value);
        updateSiteBddRenderControlLabels(tech);
        renderSiteBddLayers();
    });

    controls.siteOpacityInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.siteOpacity = Number(event.target.value);
        updateSiteBddRenderControlLabels(tech);
        renderSiteBddLayers();
    });

    controls.sectorLengthInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.sectorLengthKm = Number(event.target.value) / 1000;
        updateSiteBddRenderControlLabels(tech);
        renderSiteBddLayers();
    });

    controls.sectorWidthInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.sectorHalfAngle = Number(event.target.value) / 2;
        updateSiteBddRenderControlLabels(tech);
        renderSiteBddLayers();
    });

    controls.sectorOpacityInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.sectorOpacity = Number(event.target.value);
        updateSiteBddRenderControlLabels(tech);
        renderSiteBddLayers();
    });

    controls.labelTextColorInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.labelTextColor = event.target.value;
        renderSiteBddLayers();
    });

    controls.labelBackgroundColorInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.labelBackgroundColor = event.target.value;
        renderSiteBddLayers();
    });

    controls.labelBackgroundOpacityInput?.addEventListener('input', (event) => {
        state.siteBdd.datasets[tech].settings.labelBackgroundOpacity = Number(event.target.value);
        updateSiteBddRenderControlLabels(tech);
        renderSiteBddLayers();
    });
});

bddModeSites?.addEventListener('change', (event) => {
    if (!event.target.checked) return;
    state.siteBdd.mode = 'sites';
    renderSiteBddLayers();
});

bddModeSectors?.addEventListener('change', (event) => {
    if (!event.target.checked) return;
    state.siteBdd.mode = 'sectors';
    renderSiteBddLayers();
});

siteBddLegendName?.addEventListener('input', (event) => {
    state.siteBdd.legendName = event.target.value;
    updateLegend();
});

globalSectorLengthScaleInput?.addEventListener('input', (event) => {
    applyGlobalSectorLengthScale(Number(event.target.value));
    updateSiteBddControls();
    renderSiteBddLayers();
});

map.on('moveend zoomend', () => {
    schedulePointMarkerRender();
    renderSiteBddLayers();
    renderCustomSiteOverlays();
    renderDrawAnnotations();
});

map.on('click', (event) => {
    if (state.textTool.placing) {
        const draft = getTextAnnotationDraft();
        state.textAnnotations.push({
            id: `text-${Date.now()}`,
            latlng: event.latlng,
            ...draft
        });
        state.textTool.placing = false;
        state.textTool.selectedId = null;
        updateTextToolControls();
        renderTextAnnotations();
        return;
    }

    if (state.draw.mode === 'dot') {
        syncDrawStyleFromControls();
        const annotation = createDrawingAnnotation('dot', state.draw.defaultStyle, event.latlng, event.latlng);
        state.draw.annotations.push(annotation);
        state.draw.selectedId = annotation.id;
        updateDrawToolControls();
        renderDrawAnnotations();
        return;
    }

    if (!state.draw.mode) {
        state.draw.selectedId = null;
        updateDrawToolControls();
        renderDrawAnnotations();
    }

    if (!state.textTool.placing && state.textTool.selectedId) {
        state.textTool.selectedId = null;
        updateTextToolControls();
        renderTextAnnotations();
    }

    if (!state.ruler.active && state.ruler.selectedId) {
        state.ruler.selectedId = null;
        renderRulerMeasurements();
    }
});

map.on('mousedown', (event) => {
    if (!state.draw.mode || state.draw.mode === 'dot' || state.ruler.active || state.textTool.placing) {
        return;
    }

    syncDrawStyleFromControls();
    state.draw.activeDraft = createDrawingAnnotation(state.draw.mode, state.draw.defaultStyle, event.latlng, event.latlng);
    map.dragging.disable();
    renderDrawAnnotations();
});

map.on('mousemove', (event) => {
    if (!state.draw.activeDraft) return;
    state.draw.activeDraft.end = event.latlng;
    renderDrawAnnotations();
});

map.on('mouseup', () => {
    finalizeActiveDrawing();
});

map.getContainer().addEventListener('mousedown', addRulerPointFromMouseEvent, true);

// --- Hierarchy State ---
const hierarchy = {
    selectedRegion: null,
    selectedProvince: null,
    selectedDR: null,
    selectedCommune: null,
    visible: {
        regions: new Set(), // Set of names
        provinces: new Set(),
        communes: new Set(),
        drs: new Set()
    }
};

// --- DOM Elements for Hierarchy ---
const regionList = document.getElementById('regionList');
const provinceList = document.getElementById('provinceList');
const communeList = document.getElementById('communeList');
const drList = document.getElementById('drList');
const resetRegionBtn = document.getElementById('resetRegionBtn');

// --- Hierarchy Render Logic ---

function createListItem(name, type, isSelected, isVisible, count = null) {
    const div = document.createElement('div');
    div.className = `list-item ${isSelected ? 'selected' : ''} ${isVisible ? 'visible' : ''}`;

    const label = document.createElement('span');
    label.className = 'list-item-label';
    label.textContent = name;

    const meta = document.createElement('div');
    meta.className = 'list-item-meta';

    if (count != null) {
        const countBadge = document.createElement('span');
        countBadge.className = 'list-item-count';
        countBadge.textContent = count;
        meta.appendChild(countBadge);
    }

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = `list-item-toggle ${isVisible ? 'active' : ''}`;
    toggleBtn.title = isVisible ? `Hide ${name}` : `Show ${name}`;
    toggleBtn.textContent = isVisible ? 'On' : 'Off';
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        if (!isVisible) {
            selectItem(type, name);
        } else {
            toggleVisibility(type, name, false);
            if (type === 'region' && hierarchy.selectedRegion === name) hierarchy.selectedRegion = null;
            if (type === 'dr' && hierarchy.selectedDR === name) hierarchy.selectedDR = null;
            if (type === 'province' && hierarchy.selectedProvince === name) hierarchy.selectedProvince = null;
            if (type === 'commune' && hierarchy.selectedCommune === name) hierarchy.selectedCommune = null;
            renderRegions();
            renderDRs();
            renderProvinces();
            renderCommunes();
            renderTable();
        }
    };

    meta.appendChild(toggleBtn);
    div.appendChild(label);
    div.appendChild(meta);

    div.onclick = () => selectItem(type, name);

    return div;
}

function getHierarchyItemCount(type, name) {
    const normalizedName = normalizeName(name);

    if (type === 'region') {
        return state.processedPoints.filter((point) => normalizeName(point.region) === normalizedName).length;
    }

    if (type === 'dr') {
        return state.processedPoints.filter((point) => normalizeName(point.dr) === normalizedName).length;
    }

    if (type === 'province') {
        return state.processedPoints.filter((point) => normalizeName(point.province) === normalizedName).length;
    }

    if (type === 'commune') {
        return state.processedPoints.filter((point) => normalizeName(point.commune) === normalizedName).length;
    }

    return 0;
}

function renderRegions() {
    regionList.innerHTML = '';
    const regions = state.layers.regions.features.map(f => f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME).sort();

    regions.forEach(name => {
        const isSelected = hierarchy.selectedRegion === name;
        const isVisible = hierarchy.visible.regions.has(name);
        const count = getHierarchyItemCount('region', name);
        regionList.appendChild(createListItem(name, 'region', isSelected, isVisible, count));
    });
}

function renderDRs() {
    drList.innerHTML = '';
    const drs = state.layers.drs.features.map(f => f.properties.NAME).sort();

    drs.forEach(name => {
        const isSelected = hierarchy.selectedDR === name;
        const isVisible = hierarchy.visible.drs.has(name);
        const count = getHierarchyItemCount('dr', name);
        drList.appendChild(createListItem(name, 'dr', isSelected, isVisible, count));
    });
}

function renderProvinces() {
    provinceList.innerHTML = '';
    let provinces = state.layers.provinces.features;

    // Filter by Region
    if (hierarchy.selectedRegion) {
        // Find Region Code
        const rFeat = state.layers.regions.features.find(f => (f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME) === hierarchy.selectedRegion);
        if (rFeat) {
            const code = rFeat.properties.Code_Regio;
            provinces = provinces.filter(p => p.properties.Code_Regio === code);
        }
    }
    // Filter by DR
    else if (hierarchy.selectedDR) {
        const allowedProvinces = state.drToProvinces[hierarchy.selectedDR];
        if (allowedProvinces) {
            const normalize = (str) => String(str).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const allowedSet = new Set(allowedProvinces.map(p => normalize(p)));

            provinces = provinces.filter(p => {
                const pName = p.properties.Nom_Provin || p.properties.Nom_provin || p.properties.NAME;
                return allowedSet.has(normalize(pName));
            });
        }
    }

    const provinceNames = provinces.map(f => f.properties.Nom_Provin || f.properties.Nom_provin || f.properties.NAME).sort();
    const uniqueNames = [...new Set(provinceNames)];

    uniqueNames.forEach(name => {
        const isSelected = hierarchy.selectedProvince === name;
        const isVisible = hierarchy.visible.provinces.has(name);
        const count = getHierarchyItemCount('province', name);
        provinceList.appendChild(createListItem(name, 'province', isSelected, isVisible, count));
    });
}

function renderCommunes() {
    communeList.innerHTML = '';
    let communes = state.layers.communes.features;

    if (hierarchy.selectedProvince) {
        const pFeat = state.layers.provinces.features.find(f => (f.properties.Nom_Provin || f.properties.Nom_provin || f.properties.NAME) === hierarchy.selectedProvince);
        if (pFeat) {
            const code = pFeat.properties.Code_Provi;
            communes = communes.filter(c => c.properties.Code_Provi === code);
        }
    } else {
        // If no province selected, maybe show nothing? or all (too many!)?
        // Show all but maybe limit?
        // Let's show empty text if no province selected to save DOM
        communeList.innerHTML = '<div style="padding:0.5rem; color:#aaa">Select a Province</div>';
        return;
    }

    const communeNames = communes.map(f => f.properties.Nom_Commun || f.properties.Nom_commun || f.properties.NAME).sort();

    communeNames.forEach(name => {
        const isSelected = hierarchy.selectedCommune === name;
        const isVisible = hierarchy.visible.communes.has(name);
        const count = getHierarchyItemCount('commune', name);
        communeList.appendChild(createListItem(name, 'commune', isSelected, isVisible, count));
    });
}

// --- Interaction Logic ---
function selectItem(type, name) {
    if (type === 'region') {
        hierarchy.selectedRegion = name;
        hierarchy.selectedProvince = null;
        hierarchy.selectedDR = null;
        hierarchy.selectedCommune = null;
        hierarchy.visible.regions.add(name);

        renderRegions();
        renderDRs();
        renderProvinces();
        renderCommunes();
        updateMapVisibility('region');
        renderTable();

        if (hierarchy.selectedRegion) {
            const feat = state.layers.regions.features.find(f => (f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME) === name);
            if (feat) {
                const poly = L.geoJSON(feat);
                map.fitBounds(poly.getBounds());
            }
        }

    } else if (type === 'province') {
        hierarchy.selectedProvince = name;
        hierarchy.selectedCommune = null;
        hierarchy.visible.provinces.add(name);

        renderProvinces();
        renderCommunes();
        updateMapVisibility('province');
        renderTable();

        if (hierarchy.selectedProvince) {
            const feat = state.layers.provinces.features.find(f => (f.properties.Nom_Provin || f.properties.Nom_provin || f.properties.NAME) === name);
            if (feat) {
                const poly = L.geoJSON(feat);
                map.fitBounds(poly.getBounds());
            }
        }

    } else if (type === 'dr') {
        hierarchy.selectedDR = name;
        hierarchy.selectedRegion = null;
        hierarchy.selectedProvince = null;
        hierarchy.selectedCommune = null;
        hierarchy.visible.drs.add(name);

        renderDRs();
        renderRegions();
        renderProvinces();
        renderCommunes();
        updateMapVisibility('dr');
        renderTable();

        if (hierarchy.selectedDR) {
            const feat = state.layers.drs.features.find(f => f.properties.NAME === name);
            if (feat) {
                const poly = L.geoJSON(feat);
                map.fitBounds(poly.getBounds());
            }
        }
    } else if (type === 'commune') {
        hierarchy.selectedCommune = name;
        hierarchy.visible.communes.add(name);

        renderCommunes();
        updateMapVisibility('commune');
        renderTable();

        const feat = state.layers.communes.features.find(f => (f.properties.Nom_Commun || f.properties.Nom_commun || f.properties.NAME) === name);
        if (feat) {
            const poly = L.geoJSON(feat);
            map.fitBounds(poly.getBounds());
        }
    }
}

function toggleVisibility(type, name, isChecked) {
    const set = hierarchy.visible[type + 's']; // plural key
    if (isChecked) set.add(name);
    else set.delete(name);

    // Update Map
    updateMapVisibility(type);
    renderTable();
}

function updateMapVisibility(type) {
    const group = state.mapLayerGroups[type + 's'];
    group.clearLayers();

    const set = hierarchy.visible[type + 's'];
    const layerData = state.layers[type + 's'];

    if (!layerData) return;

    const featuresToShow = layerData.features.filter(f => {
        const n = f.properties.Nom_Region || f.properties.Nom_Provin || f.properties.Nom_Commun || f.properties.NAME || f.properties.Nom_region || f.properties.Nom_provin || f.properties.Nom_commun;
        return set.has(n);
    });

    // Style
    let style = { color: '#3388ff', weight: 1 };
    if (type === 'region') style = (f) => ({ color: state.regionColors[f.properties.Nom_Region || f.properties.NAME] || '#3388ff', weight: 2, fillOpacity: 0.4 });
    if (type === 'dr') style = (f) => ({ color: state.drColors[f.properties.NAME] || '#8b5cf6', weight: 2, fillOpacity: 0.4, dashArray: '5, 5' });
    if (type === 'province') style = { color: '#10b981', weight: 1, fillOpacity: 0.1 };
    if (type === 'commune') style = { color: '#ec4899', weight: 0.5, fillOpacity: 0.1 };

    if (featuresToShow.length > 0) { // Optimization
        L.geoJSON({ type: "FeatureCollection", features: featuresToShow }, {
            style: style,
            onEachFeature: (feature, layer) => {
                const n = feature.properties.Nom_Region || feature.properties.Nom_Provin || feature.properties.Nom_Commun || feature.properties.NAME;
                layer.bindPopup(n);
            }
        }).addTo(group);
    }
    updateLegend();
}

resetRegionBtn.addEventListener('click', () => {
    hierarchy.visible.regions.clear();
    hierarchy.visible.provinces.clear();
    hierarchy.visible.communes.clear();
    hierarchy.visible.drs.clear();
    hierarchy.selectedRegion = null;
    hierarchy.selectedProvince = null;
    hierarchy.selectedDR = null;
    hierarchy.selectedCommune = null;
    renderRegions();
    renderDRs();
    renderProvinces();
    renderCommunes();
    updateMapVisibility('region');
    updateMapVisibility('dr');
    updateMapVisibility('province');
    updateMapVisibility('commune');
    renderTable();
    map.setView([31.7917, -7.0926], 6);
});

// --- Export ---
exportBtn.addEventListener('click', async () => {
    const XLSX = await loadXlsxModule();
    const dataToExport = buildExportRows(state.processedPoints);

    const ws = XLSX.utils.json_to_sheet(dataToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");

    if (state.comparisonReport.countDifferences.length > 0) {
        const countWs = XLSX.utils.json_to_sheet(state.comparisonReport.countDifferences.map(item => ({
            Field: item.field,
            Value: item.value,
            Original_Count: item.originalCount,
            Calculated_Count: item.calculatedCount,
            Difference: item.difference
        })));
        XLSX.utils.book_append_sheet(wb, countWs, "Count Divergences");
    }

    if (state.comparisonReport.rowDivergences.length > 0) {
        const rowWs = XLSX.utils.json_to_sheet(state.comparisonReport.rowDivergences.map(item => ({
            Code: item.code,
            Localite: item.locality,
            Field: item.field,
            Original: item.original,
            Calculated: item.calculated,
            Nearest_Place: item.nearestPlace || '',
            Nearest_Place_Distance_Km: Number.isFinite(item.nearestPlaceDistanceKm) ? Number(item.nearestPlaceDistanceKm.toFixed(3)) : '',
            Inhabited_Area: item.inhabitedArea || '',
            Inhabited_Area_Distance_Km: Number.isFinite(item.inhabitedAreaDistanceKm) ? Number(item.inhabitedAreaDistanceKm.toFixed(3)) : '',
            Inside_Inhabited_Area: item.isInsideInhabitedArea ? 'Yes' : 'No',
            Review_Risk_Score: (() => {
                const point = state.processedPoints.find((candidate) => String(candidate.original?.Code || candidate.id) === String(item.code));
                return Number.isFinite(point?.reviewRiskScore) ? Math.round(point.reviewRiskScore) : '';
            })(),
            Review_Risk_Level: (() => {
                const point = state.processedPoints.find((candidate) => String(candidate.original?.Code || candidate.id) === String(item.code));
                return point?.reviewRiskLevel || '';
            })()
        })));
        XLSX.utils.book_append_sheet(wb, rowWs, "Row Divergences");
    }

    XLSX.writeFile(wb, "geo_analysis_results.xlsx");
});

exportDisplayedBtn.addEventListener('click', async () => {
    const displayedPoints = state.filteredPoints.slice(0, 500);
    if (!displayedPoints.length) {
        alert('No rows are currently displayed in the table.');
        return;
    }

    const XLSX = await loadXlsxModule();
    const dataToExport = buildDisplayedTableExportRows(displayedPoints);
    const ws = XLSX.utils.aoa_to_sheet(dataToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Displayed Results");
    XLSX.writeFile(wb, "geo_analysis_displayed_rows.xlsx");
});

exportHierarchyBtn.addEventListener('click', async () => {
    if (!state.layers.regions || !state.layers.provinces || !state.layers.communes) {
        alert("Map data not loaded yet.");
        return;
    }
    const XLSX = await loadXlsxModule();

    const rows = [];
    const regions = state.layers.regions.features;
    const provinces = state.layers.provinces.features;
    const communes = state.layers.communes.features;

    regions.forEach(regionFeat => {
        const rProps = regionFeat.properties;
        const rName = rProps.Nom_Region || rProps.Nom_region || rProps.NAME;
        const rCode = rProps.Code_Regio;

        // Find Provinces
        const regionProvinces = provinces.filter(p => p.properties.Code_Regio === rCode);

        if (regionProvinces.length === 0) {
            rows.push({ Region: rName, Province: '', Commune: '' });
        } else {
            regionProvinces.forEach(provFeat => {
                const pProps = provFeat.properties;
                const pName = pProps.Nom_Provin || pProps.Nom_provin || pProps.NAME;
                const pCode = pProps.Code_Provi;

                // Find Communes
                const provCommunes = communes.filter(c => c.properties.Code_Provi === pCode);

                if (provCommunes.length === 0) {
                    rows.push({ Region: rName, Province: pName, Commune: '' });
                } else {
                    provCommunes.forEach(commFeat => {
                        const cProps = commFeat.properties;
                        const cName = cProps.Nom_Commun || cProps.Nom_commun || cProps.NAME;
                        rows.push({ Region: rName, Province: pName, Commune: cName });
                    });
                }
            });
        }
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Hierarchy");
    XLSX.writeFile(wb, "regions_provinces_communes.xlsx");
});

// --- Site Search ---
siteSearchBtn.addEventListener('click', () => {
    runSiteSearch();
});

clearSearchBtn.addEventListener('click', () => {
    clearSearchSelection();
});

siteSearchInput.addEventListener('input', () => {
    const query = siteSearchInput.value.trim();
    if (!query) {
        state.searchRequestId += 1;
        clearTimeout(searchInputTimer);
        clearSearchSelection({ keepInput: true });
        return;
    }

    if (query.length >= 2) {
        clearTimeout(searchInputTimer);
        searchInputTimer = window.setTimeout(() => {
            runSiteSearch();
        }, SEARCH_DEBOUNCE_MS);
    } else {
        state.searchRequestId += 1;
        searchResultsDropdown.style.display = 'none';
        searchResultsDropdown.innerHTML = '';
    }
});

siteSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        runSiteSearch();
    }
});

document.addEventListener('click', (event) => {
    if (
        event.target !== siteSearchInput &&
        event.target !== siteSearchBtn &&
        event.target !== clearSearchBtn &&
        !searchResultsDropdown.contains(event.target)
    ) {
        searchResultsDropdown.style.display = 'none';
    }
});

// --- Sidebar Toggle ---
toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');

    // Resize map after transition
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
});

// --- Manual Add ---
addSiteBtn.addEventListener('click', () => {
    const name = manualSiteName.value.trim();
    const lat = parseFloat(manualLat.value);
    const lng = parseFloat(manualLng.value);

    if (!name || isNaN(lat) || isNaN(lng)) {
        alert("Please enter valid Name, Latitude, and Longitude.");
        return;
    }

    const manualId = `manual-${Date.now()}`;
    const newPoint = {
        id: manualId,
        displayName: name,
        lat: lat,
        lng: lng,
        isManualAdded: true,
        original: { 'Site Name': name, 'Code': name, 'Latitude': lat, 'Longitude': lng, '__manualAdded': true } // Mock original data
    };

    state.manualSites.push({
        id: manualId,
        name,
        lat,
        lng
    });
    renderManualSites();
    state.points.push(newPoint);
    updateStatus(true, "Processing new site...");

    // Clear inputs
    manualSiteName.value = '';
    manualLat.value = '';
    manualLng.value = '';

    // Re-run analysis to categorize the new point
    // Optimization: Could just process this one point, but analyzePoints handles everything.
    // Given < 10k points, full re-run is acceptable for safety and simplicity.
    setTimeout(() => {
        analyzePoints().then((result) => {
            if (!result) return;
            const found = state.processedPoints.find(p => p.id === manualId);
            if (found) {
                focusPointOnMap(found);
                renderManualSites();
            }
        });
    }, 100);
});

if (saveWikimapiaKeyBtn) {
    saveWikimapiaKeyBtn.addEventListener('click', () => {
        saveWikimapiaApiKey();
    });
}

if (clearWikimapiaKeyBtn) {
    clearWikimapiaKeyBtn.addEventListener('click', () => {
        clearWikimapiaApiKey();
    });
}

if (wikimapiaApiKeyInput) {
    wikimapiaApiKeyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveWikimapiaApiKey();
        }
    });
}


// Start
updateWikimapiaKeyStatus();
updateNetworkBadgeControls();
updateDrawToolControls();
updateRulerControls();
updateTextToolControls();
renderManualSites();
renderDrawAnnotations();
renderRulerMeasurements();
renderTextAnnotations();
updateSiteBddControls();
updateCustomSiteOverlaySummary();
renderCustomSiteOverlayControls();
updateSiteBddHint('');
loadGeoData();
// --- Resize Logic ---
const resizeHandle = document.getElementById('resizeHandle');
const tableContainer = document.getElementById('tableContainer');
let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'row-resize';
    e.preventDefault(); // Prevent text selection
});

document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // Calculate new height based on mouse position
    // We want the height to be the distance from the bottom of the container to the mouse Y
    // But since it's a flex item at the bottom, we can perhaps just set height directly based on container bottom - mouse Y

    const containerRect = tableContainer.parentElement.getBoundingClientRect();
    const newHeight = containerRect.bottom - e.clientY;

    // Constraints
    const minHeight = 150;
    const maxHeight = containerRect.height - 100; // Leave some space for map

    if (newHeight >= minHeight && newHeight <= maxHeight) {
        tableContainer.style.height = `${newHeight}px`;
    }
});

document.addEventListener('mouseup', () => {
    if (isResizing) {
        isResizing = false;
        document.body.style.cursor = 'default';
        // Trigger map resize if needed (Leaflet checks size periodically but good to force)
        map.invalidateSize();
    }
});
