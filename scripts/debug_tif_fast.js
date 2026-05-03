
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

        const width = image.getWidth();
        const height = image.getHeight();

        const uniqueValues = new Set();
        const maxSamples = 1000;
        let samples = 0;

        // Sample random locations
        for (let i = 0; i < 5000; i++) {
            const x = Math.floor(Math.random() * width);
            const y = Math.floor(Math.random() * height);
            const rasters = await image.readRasters({ window: [x, y, x + 1, y + 1] });
            const val = rasters[0][0];

            if (val !== 0 && val > -1000) {
                uniqueValues.add(val);
                if (uniqueValues.size > 20) break;
            }
        }

        console.log("Unique Values Found:", Array.from(uniqueValues));

    } catch (e) {
        console.error("Error:", e);
    }
}

inspect();
