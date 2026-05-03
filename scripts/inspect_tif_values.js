
import * as GeoTIFF from 'geotiff';
import fs from 'fs/promises';
import path from 'path';

const FILE_PATH = './public/Planet/4G_DEC_2021/4G_Coverage.tif';

async function inspect() {
    try {
        console.log(`Reading ${FILE_PATH}...`);
        const buffer = await fs.readFile(FILE_PATH);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();

        const width = image.getWidth();
        const height = image.getHeight();
        console.log(`Dimensions: ${width} x ${height}`);

        const pool = new GeoTIFF.Pool();
        const counts = {};
        const uniqueValues = new Set();

        const numStrips = 50;
        const stripHeight = Math.floor(height / numStrips);

        console.log(`Scanning ${numStrips} strips...`);

        for (let s = 0; s < numStrips; s++) {
            const y = s * stripHeight + Math.floor(stripHeight / 2);
            if (y >= height) break;

            const window = [0, y, width, y + 1]; // Read 1 line

            try {
                const rasters = await image.readRasters({ window, pool });
                const data = rasters[0];

                for (let i = 0; i < data.length; i += 10) {
                    const val = data[i];
                    // -3.4028234663852886e+38 is typical Float32 NoData
                    if (val !== 0 && val > -200 && val < 200) {
                        const v = Math.round(val * 100) / 100;
                        uniqueValues.add(v);
                        counts[v] = (counts[v] || 0) + 1;
                    }
                }
            } catch (e) {
                // Ignore strip errors
            }
        }

        console.log("Unique values found:", Array.from(uniqueValues).sort((a, b) => a - b));

        const sortedKeys = Object.keys(counts).sort((a, b) => parseFloat(a) - parseFloat(b));
        // Print all counts if small, or top ones
        console.log("All Value Counts:", counts);

    } catch (e) {
        console.error(e);
    }
}

inspect();
