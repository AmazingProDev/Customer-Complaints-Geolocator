import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const workbook = XLSX.readFile('Province to DR.xlsx');
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(sheet);

if (data.length > 0) {
    console.log("Headers:", Object.keys(data[0]));
    console.log("First row:", data[0]);
} else {
    console.log("File is empty");
}
