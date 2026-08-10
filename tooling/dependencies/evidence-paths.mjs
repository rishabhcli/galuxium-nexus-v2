import path from 'node:path';

const GENERIC_HOME_PATH_PATTERN =
  /(?:\/(?:Users|home)\/[^/\s"'()]+(?:\/|$)|[A-Za-z]:\\Users\\[^\\\s"'()]+(?:\\|$))/u;

function isWithin(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function portableRelativePath(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' ? '.' : relativePath.split(path.sep).join('/');
}

function replaceAllLiteral(value, search, replacement) {
  return search === '' ? value : value.split(search).join(replacement);
}

export function normalizeEvidencePath(targetPath, options) {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const absolutePath = path.resolve(targetPath);
  if (isWithin(repositoryRoot, absolutePath)) {
    return portableRelativePath(repositoryRoot, absolutePath);
  }

  if (typeof options.homeDirectory === 'string' && options.homeDirectory !== '') {
    const homeDirectory = path.resolve(options.homeDirectory);
    if (isWithin(homeDirectory, absolutePath)) {
      const relativePath = portableRelativePath(homeDirectory, absolutePath);
      return relativePath === '.' ? '<home>' : `<home>/${relativePath}`;
    }
  }
  return absolutePath;
}

export function normalizeLocalRootsInText(value, options) {
  let normalized = replaceAllLiteral(value, path.resolve(options.repositoryRoot), '.');
  if (typeof options.homeDirectory === 'string' && options.homeDirectory !== '') {
    normalized = replaceAllLiteral(normalized, path.resolve(options.homeDirectory), '<home>');
  }
  return normalized;
}

export function assertNoAbsoluteLocalPaths(value, options, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoAbsoluteLocalPaths(entry, options, `${location}[${String(index)}]`),
    );
    return;
  }
  if (typeof value === 'object' && value !== null) {
    let index = 0;
    for (const [key, child] of Object.entries(value)) {
      assertNoAbsoluteLocalPaths(key, options, `${location}.objectKey[${String(index)}]`);
      assertNoAbsoluteLocalPaths(child, options, `${location}.objectValue[${String(index)}]`);
      index += 1;
    }
    return;
  }
  if (typeof value !== 'string') {
    return;
  }

  const repositoryRoot = path.resolve(options.repositoryRoot);
  const homeDirectory =
    typeof options.homeDirectory === 'string' && options.homeDirectory !== ''
      ? path.resolve(options.homeDirectory)
      : null;
  if (
    value.includes(repositoryRoot) ||
    (homeDirectory !== null && value.includes(homeDirectory)) ||
    GENERIC_HOME_PATH_PATTERN.test(value)
  ) {
    throw new Error(`Evidence contains an absolute repository or home path at ${location}.`);
  }
}

export function assertEvidencePathSafetyRefusals(options) {
  const probes = [
    path.join(path.resolve(options.repositoryRoot), '.dev', 'private-artifact'),
    path.join(
      typeof options.homeDirectory === 'string' && options.homeDirectory !== ''
        ? path.resolve(options.homeDirectory)
        : '/home/dependency-reviewer',
      '.private-artifact',
    ),
    String.raw`C:\Users\dependency-reviewer\private-artifact`,
    'prefix:/Users/dependency-reviewer/private-artifact',
    String.raw`prefix:C:\Users\dependency-reviewer\private-artifact`,
  ];
  for (const probe of probes) {
    try {
      assertNoAbsoluteLocalPaths({ path: probe }, options);
    } catch (error) {
      if (error instanceof Error && /absolute repository or home path/u.test(error.message)) {
        continue;
      }
      throw error;
    }
    throw new Error(`Evidence local-path negative probe was accepted: ${probe}`);
  }
  try {
    assertNoAbsoluteLocalPaths(
      { '/home/dependency-reviewer/private-key-path': 'safe-value' },
      options,
    );
  } catch (error) {
    if (!(error instanceof Error && /absolute repository or home path/u.test(error.message))) {
      throw error;
    }
    probes.push('object key containing /home/dependency-reviewer/');
  }
  if (probes.length !== 6) {
    throw new Error('Evidence object-key local-path negative probe was accepted.');
  }
  assertNoAbsoluteLocalPaths({ path: '/opt/external-toolchain/bin/tool' }, options);
  return { refusedProbeCount: probes.length };
}
