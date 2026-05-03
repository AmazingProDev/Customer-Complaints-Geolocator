
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

        console.log("Image Width:", image.getWidth());
        console.log("Image Height:", image.getHeight());

        const width = image.getWidth();
        const height = image.getHeight();
        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        let validCount = 0;

        // Sample every 100th row to speed up
        // Sample every 10th column
        // Total samples approx (16000/100) * (16000/10) = 160 * 1600 = 256,000 samples. Fast enough.

        for (let row = 0; row < height; row += 100) {
            const rasters = await image.readRasters({ window: [0, row, width, row + 1] });
            const data = rasters[0];
            for (let i = 0; i < data.length; i += 10) {
                const val = data[i];
                // Assume -1000 is nodata (usually nodata is like -9999 or very small)
                if (val > -500 && val !== 0) {
                    if (val < min) min = val;
                    if (val > max) max = val;
                    validCount++;
                }
                count++;
            }
        }

        console.log("Stats (Sampled):");
        console.log("Min Value:", min);
        console.log("Max Value:", max);
        console.log("Valid Samples:", validCount);

    } catch (e) {
        console.error("Error:", e);
    }
}

inspect();
