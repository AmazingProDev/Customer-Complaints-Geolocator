import fs from 'fs';

const loadJSON = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));

const communes = loadJSON('public/data/communes.json');
const provinces = loadJSON('public/data/provinces.json');

const targetCommunes = ['Charrate'];

targetCommunes.forEach(target => {
    const normalize = (str) => String(str).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    const found = communes.features.find(f => {
        const props = f.properties;
        const name = props.Nom_Commun || props.Nom_commun || props.NAME;
        return normalize(name) === normalize(target);
    });

    if (found) {
        const props = found.properties;
        const name = props.Nom_Commun || props.Nom_commun || props.NAME;
        const provCode = props.Code_Provi;

        // Find province by code
        const prov = provinces.features.find(p => p.properties.Code_Provi === provCode);
        const provName = prov ? (prov.properties.Nom_Provin || prov.properties.Nom_provin || prov.properties.NAME) : 'Unknown';

        console.log(`Commune: ${name}, Province Code: ${provCode}, Province Name: ${provName}`);
    } else {
        console.log(`Commune ${target} not found.`);
    }
});
