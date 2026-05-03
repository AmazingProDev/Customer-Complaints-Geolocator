
import proj4 from 'proj4';
import { exec } from 'child_process';
import path from 'path';

const UTM_29N = "+proj=utm +zone=29 +north +ellps=WGS84 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs";


const lat = 24.26900;
const lng = -13.14000;

const [x, y] = proj4(WGS84, UTM_29N, [lng, lat]);

console.log(`Point: ${lat}, ${lng}`);
console.log(`UTM: ${x}, ${y}`);

const cmd = `ogrinfo -al -spat ${x - 10} ${y - 10} ${x + 10} ${y + 10} "/Users/abdelilah/Desktop/SS-COP/public/Planet/4G_DEC_2021/LTE_Couverture downlink part10.tab" | grep "THRESHOLD" | head -n 20`;

console.log("Running:", cmd);

exec(cmd, (error, stdout, stderr) => {
    if (error) {
        console.error(`exec error: ${error}`);
        return;
    }
    console.log(`stdout: ${stdout}`);
    console.error(`stderr: ${stderr}`);
});
