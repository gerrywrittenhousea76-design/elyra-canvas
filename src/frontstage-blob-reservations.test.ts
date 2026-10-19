import { describe, expect, it } from 'vitest';
import { FrontstageBlobReservations } from './frontstage-blob-reservations';

describe('CORE-012 frontstage Blob reservations', () => {
  it('keeps staged locators isolated by project until ownership transfers', () => {
    const registry = new FrontstageBlobReservations();
    const locatorA = 'indexeddb://elyra-assets/project-a/blob-a';
    const locatorB = 'indexeddb://elyra-assets/project-b/blob-b';

    registry.reserve('project-a', locatorA);
    registry.reserve('project-b', locatorB);

    expect(registry.locatorsFor('project-a')).toEqual([locatorA]);
    expect(registry.locatorsFor('project-b')).toEqual([locatorB]);
    expect(registry.release('project-a', locatorA)).toBe(true);
    expect(registry.locatorsFor('project-a')).toEqual([]);
    expect(registry.locatorsFor('project-b')).toEqual([locatorB]);
  });

  it('fails closed when a caller tries to reserve or release across projects', () => {
    const registry = new FrontstageBlobReservations();
    const locator = 'indexeddb://elyra-assets/project-a/blob-a';

    expect(() => registry.reserve('project-b', locator)).toThrow('FRONTSTAGE_BLOB_PROJECT_BOUNDARY_MISMATCH');
    registry.reserve('project-a', locator);
    expect(() => registry.release('project-b', locator)).toThrow('FRONTSTAGE_BLOB_PROJECT_BOUNDARY_MISMATCH');
    expect(registry.locatorsFor('project-a')).toEqual([locator]);
  });

  it('deduplicates repeated reservations and returns an immutable snapshot', () => {
    const registry = new FrontstageBlobReservations();
    const locator = 'indexeddb://elyra-assets/project-a/blob-a';
    registry.reserve('project-a', locator);
    registry.reserve('project-a', locator);

    const snapshot = registry.locatorsFor('project-a') as string[];
    snapshot.push('caller-only');
    expect(registry.locatorsFor('project-a')).toEqual([locator]);
  });
});
