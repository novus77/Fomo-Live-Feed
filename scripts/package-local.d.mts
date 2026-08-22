export interface GuideMetadata {
  version: string;
  builtAt: string;
}

export function artifactName(version: string): string;
export function renderGuide(metadata: GuideMetadata): string;
export function parseManifest(
  source: string,
  expectedVersion: string,
): { manifest_version: 3; version: string; [key: string]: unknown };
export function assertAllowedRelativePaths(paths: readonly string[]): void;
export function sha256File(path: string): Promise<string>;
export interface PackageLocalReleaseOptions {
  projectRoot: string;
  builtAt?: string;
}
export interface PackageLocalReleaseResult {
  artifactPath: string;
  checksumPath: string;
}
export function packageLocalRelease(
  options: PackageLocalReleaseOptions,
): Promise<PackageLocalReleaseResult>;
