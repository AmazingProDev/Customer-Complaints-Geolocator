import test from 'node:test';
import assert from 'node:assert/strict';

import {
    collectExactSiteNameMatches,
    formatSiteNameMatchMeta
} from '../src/siteNameSearch.js';

const SITE_BDD_CONFIG = {
    '2G': { label: 'BDD 2G' },
    '3G': { label: 'BDD 3G' },
    '4G': { label: 'BDD 4G' }
};

test('collectExactSiteNameMatches returns every BDD and imported workbook site with the same normalized name', () => {
    const results = collectExactSiteNameMatches({
        queryText: 'ALPHA+ONE',
        siteBddConfig: SITE_BDD_CONFIG,
        siteBddState: {
            datasets: {
                '2G': {
                    sites: [
                        { siteName: 'Alpha One', lat: 33.1, lng: -7.1, sectorCount: 2 }
                    ]
                },
                '3G': {
                    sites: [
                        { siteName: 'Alpha One', lat: 33.2, lng: -7.2, sectorCount: 3 }
                    ]
                },
                '4G': {
                    sites: [
                        { siteName: 'Beta One', lat: 33.3, lng: -7.3, sectorCount: 4 }
                    ]
                }
            }
        },
        processedPoints: [
            {
                id: 'import-1',
                displayName: 'Alpha One',
                lat: 34.1,
                lng: -6.1
            },
            {
                id: 'import-2',
                displayName: 'Alpha One',
                lat: 34.2,
                lng: -6.2
            },
            {
                id: 'import-3',
                displayName: 'Gamma One',
                lat: 34.3,
                lng: -6.3
            }
        ]
    });

    assert.equal(results.length, 4);
    assert.deepEqual(
        results.map((result) => ({
            category: result.category,
            sourceLabel: result.sourceLabel,
            lat: result.lat,
            lng: result.lng
        })),
        [
            { category: 'site_bdd', sourceLabel: 'BDD 2G', lat: 33.1, lng: -7.1 },
            { category: 'site_bdd', sourceLabel: 'BDD 3G', lat: 33.2, lng: -7.2 },
            { category: 'site', sourceLabel: 'Imported workbook site', lat: 34.1, lng: -6.1 },
            { category: 'site', sourceLabel: 'Imported workbook site', lat: 34.2, lng: -6.2 }
        ]
    );
});

test('collectExactSiteNameMatches ignores partial-only name matches', () => {
    const results = collectExactSiteNameMatches({
        queryText: 'Alpha',
        siteBddConfig: SITE_BDD_CONFIG,
        siteBddState: {
            datasets: {
                '2G': {
                    sites: [
                        { siteName: 'Alpha One', lat: 33.1, lng: -7.1, sectorCount: 2 }
                    ]
                },
                '3G': { sites: [] },
                '4G': { sites: [] }
            }
        },
        processedPoints: [
            {
                id: 'import-1',
                displayName: 'Alpha One',
                lat: 34.1,
                lng: -6.1
            }
        ]
    });

    assert.deepEqual(results, []);
});

test('formatSiteNameMatchMeta shows source and coordinates for duplicates', () => {
    assert.equal(
        formatSiteNameMatchMeta({
            sourceLabel: 'BDD 4G',
            lat: 31.23456789,
            lng: -8.76543219
        }),
        'BDD 4G • 31.234568, -8.765432'
    );
});
