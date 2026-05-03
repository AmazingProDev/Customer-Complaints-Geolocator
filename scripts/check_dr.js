import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const workbook = XLSX.readFile('Province to DR.xlsx');
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(sheet);

const normalize = (str) => String(str).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const found = data.find(row => normalize(row['Province']) === 'benslimane');

if (found) {
    console.log(`Benslimane is in DR: ${found['DR']}`);
} else {
    console.log('Benslimane not found in mapping.');
}
