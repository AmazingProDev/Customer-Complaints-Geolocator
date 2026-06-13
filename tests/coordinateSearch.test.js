import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createCoordinateSearchResult,
    parseCoordinateSearchQuery
} from '../src/coordinateSearch.js';

test('parseCoordinateSearchQuery accepts comma-separated lat/lng', () => {
    assert.deepEqual(
        parseCoordinateSearchQuery('33.5731, -7.5898'),
        { lat: 33.5731, lng: -7.5898 }
    );
});

test('parseCoordinateSearchQuery accepts space-separated lat/lng', () => {
    assert.deepEqual(
        parseCoordinateSearchQuery('33.5731 -7.5898'),
        { lat: 33.5731, lng: -7.5898 }
    );
});

test('parseCoordinateSearchQuery rejects out-of-range and partial values', () => {
    assert.equal(parseCoordinateSearchQuery('95, -7.5898'), null);
    assert.equal(parseCoordinateSearchQuery('33.5731,'), null);
});

test('createCoordinateSearchResult returns a dropdown-ready coordinates result', () => {
    assert.deepEqual(
        createCoordinateSearchResult('33.5731, -7.5898'),
        {
            category: 'coordinates',
            name: 'Coordinates (33.573100, -7.589800)',
            sourceLabel: 'Coordinates',
            metaLabel: 'Coordinates • 33.573100, -7.589800',
            lat: 33.5731,
            lng: -7.5898
        }
    );
});
