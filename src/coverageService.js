
import * as GeoTIFF from 'geotiff';
import proj4 from 'proj4';


// Define projection (WGS84 / UTM Zone 29N)
const UTM_29N = "+proj=utm +zone=29 +north +ellps=WGS84 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs";

const LAYERS = {
    '2G': {
        url: '/Planet/2G_DEC_2021/2G_DEC_2021_BestServerSS_GSM_M_Classified_Convert.tif'
    },
    '3G': {
        url: null // User reported empty
    },
    '4G': {
        url: '/Planet/4G_DEC_2021/4G_Coverage.tif'
    }
};

const state = {
    images: {},
    metadata: {}
};

function isValidTiffHeader(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 4) {
        return false;
    }

    const bytes = new Uint8Array(arrayBuffer, 0, 4);
    const isLittleEndian = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00;
    const isBigEndian = bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A;
    return isLittleEndian || isBigEndian;
}

export async function initCoverageService() {
    try {
        console.log("Initializing Coverage Service...");

        await Promise.all(Object.keys(LAYERS).map(async (key) => {
            const layer = LAYERS[key];
            if (!layer || !layer.url) {
                console.log(`Skipping ${key} layer (no URL provided)`);
                return;
            }
            try {
                const response = await fetch(layer.url);
                if (!response.ok) {
                    console.warn(`Layer ${key} not found at ${layer.url}`);
                    return;
                }
                const arrayBuffer = await response.arrayBuffer();
                if (!isValidTiffHeader(arrayBuffer)) {
                    console.warn(`Skipping ${key} layer because the file is not a valid TIFF.`);
                    return;
                }
                const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
                const image = await tiff.getImage();

                state.images[key] = image;
                state.metadata[key] = {
                    origin: image.getOrigin(),
                    resolution: image.getResolution()
                };

                console.log(`Loaded ${key} layer. Origin: ${state.metadata[key].origin}, Res: ${state.metadata[key].resolution}`);
            } catch (e) {
                console.warn(`Skipping ${key} layer because it could not be read:`, e);
            }
        }));

        console.log("Coverage Service Initialized.");
    } catch (err) {
        console.error("Critical error in Coverage Service init:", err);
    }
}

export async function getCoverage(lat, lng) {
    // Project Lat/Lng to UTM
    const [utmX, utmY] = proj4(WGS84, UTM_29N, [lng, lat]);

    const results = {
        '2G': null,
        '3G': null,
        '4G': null
    };

    for (const key of ['2G', '3G', '4G']) {
        const image = state.images[key];
        const meta = state.metadata[key];

        if (!image || !meta) {
            results[key] = "N/A";
            continue;
        }

        const [originX, originY] = meta.origin;
        const [resX, resY] = meta.resolution; // resY is typically negative

        // Calculate pixel coordinates
        // X = originX + col * resX  => col = (X - originX) / resX
        // Y = originY + row * resY  => row = (Y - originY) / resY

        const col = Math.floor((utmX - originX) / resX);
        const row = Math.floor((utmY - originY) / resY);

        // Check bounds
        const width = image.getWidth();
        const height = image.getHeight();

        if (col < 0 || col >= width || row < 0 || row >= height) {
            results[key] = "Out of bounds";
            continue;
        }

        try {
            // Read single pixel
            const rasters = await image.readRasters({ window: [col, row, col + 1, row + 1] });
            const value = rasters[0][0]; // Channel 0, Pixel 0

            // Mask NoData / Default values
            if (value < -200 || value === 0) {
                results[key] = "N/A";
            } else {
                results[key] = parseFloat(value.toFixed(2));
            }
        } catch (e) {
            console.error(`Error reading raster ${key}:`, e);
            results[key] = "Error";
        }
    }

    return results;
}
