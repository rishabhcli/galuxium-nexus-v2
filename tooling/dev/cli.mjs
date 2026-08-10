import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { printFailure } from './errors.mjs';

export function isMain(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }
  return pathToFileURL(path.resolve(process.argv[1])).href === importMetaUrl;
}

export async function runCli(action) {
  try {
    await action();
  } catch (error) {
    printFailure(error);
    process.exitCode = 1;
  }
}
