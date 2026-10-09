import { cp, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
await mkdir(dist, { recursive: true });
await cp(resolve(here, '../../public'), dist, { recursive: true, force: true });
await copyFile(resolve(here, 'proxy.mjs'), resolve(dist, '_worker.js'));
