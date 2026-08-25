import * as fs from 'node:fs';
import * as path from 'node:path';

export const MANIFEST_NAMES = ['amxbuild.yml', 'amxbuild.yaml', 'manifest.yml'] as const;

/**
 * Walk up from a directory to find a build manifest (amxbuild.yml /
 * amxbuild.yaml / manifest.yml). Used to locate a dependency's own manifest
 * from its include directory inside the amxb cache checkout.
 */
export function findManifestUp(startDir: string, maxLevels = 6): string | undefined {
  let dir = startDir;
  for (let level = 0; level < maxLevels; level += 1) {
    for (const name of MANIFEST_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
