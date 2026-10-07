import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from this module until a package.json is found. Works both under
 * tsx (src/config) and after build (dist/config), so views/public can live
 * at the project root without asset-copying steps.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const projectRoot = findProjectRoot(moduleDir);
export const viewsDir = path.join(projectRoot, 'views');
export const publicDir = path.join(projectRoot, 'public');

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
