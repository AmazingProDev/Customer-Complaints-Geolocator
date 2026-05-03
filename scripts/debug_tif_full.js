
import * as GeoTIFF from 'geotiff';
import fs from 'fs';
import path from 'path';

async function inspect() {
    const filePath = path.resolve('public/Planet/3G_DEC2021/3G_DEC2021_CpchComFS_Common_M_Classified_Convert.tif');
    console.log("Reading file:", filePath);

    try {
        const buffer = fs.readFileSync(filePath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();

        console.log("Analyzing Band 1...");

        const width = image.getWidth();
        const height = image.getHeight();
        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        let validCount = 0;

        // Block reading for better performance/memory management
        const blockHeight = 1000;

        for (let y = 0; y < height; y += blockHeight) {
            const h = Math.min(blockHeight, height - y);
            const rasters = await image.readRasters({ window: [0, y, width, y + h] });
            const data = rasters[0]; // Band 1

            for (let i = 0; i < data.length; i++) {
                const val = data[i];
                // Ignore NoData (usually -9999 or similar, or 0 if masked)
                // Let's assume valid data is between -200 and 100 for dBm/dB
                if (val > -1000 && val !== 0) {
                    if (val < min) min = val;
                    if (val > max) max = val;
                    validCount++;
                }
                count++;
            }
            if (y % 5000 === 0) console.log(`Processed row ${y}/${height}...`);
        }

        console.log("Analysis Complete.");
        console.log("Min Band1 Value:", min);
        console.log("Max Band1 Value:", max);
        console.log("Total Pixels:", count);
        console.log("Valid Pixels:", validCount);

    } catch (e) {
        console.error("Error:", e);
    }
}

inspect();
