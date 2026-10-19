import { parseBlobLocator } from './blob-store';

/**
 * Tracks frontstage Blob bytes that are not yet owned by either a Workspace or
 * a pending handoff. The registry is intentionally in-memory: a browser crash
 * leaves an unowned Blob that the next startup cleanup can safely reclaim.
 */
export class FrontstageBlobReservations {
  private readonly byProject = new Map<string, Set<string>>();

  reserve(projectId: string, locator: string) {
    const parsed = parseBlobLocator(locator);
    if (parsed.projectId !== projectId) throw new Error('FRONTSTAGE_BLOB_PROJECT_BOUNDARY_MISMATCH');
    const projectLocators = this.byProject.get(projectId) ?? new Set<string>();
    projectLocators.add(locator);
    this.byProject.set(projectId, projectLocators);
  }

  release(projectId: string, locator: string) {
    const parsed = parseBlobLocator(locator);
    if (parsed.projectId !== projectId) throw new Error('FRONTSTAGE_BLOB_PROJECT_BOUNDARY_MISMATCH');
    const projectLocators = this.byProject.get(projectId);
    if (!projectLocators) return false;
    const removed = projectLocators.delete(locator);
    if (projectLocators.size === 0) this.byProject.delete(projectId);
    return removed;
  }

  locatorsFor(projectId: string): readonly string[] {
    return [...(this.byProject.get(projectId) ?? [])].sort();
  }
}
