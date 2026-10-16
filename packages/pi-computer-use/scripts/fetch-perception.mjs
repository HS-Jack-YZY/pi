#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(join(packageRoot, 'perception-release.json'), 'utf8'));
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const artifact = release.targets[target];
if (!artifact) throw new Error(`Unsupported Cua Perception target: ${target}`);
const work = mkdtempSync(join(tmpdir(), `pi-cua-perception-${target}-`));
try {
  for (const [name, hash, size] of [
    [artifact.catalog, artifact.catalogSha256],
    [artifact.archive, artifact.archiveSha256, artifact.archiveSize],
  ]) {
    const response = await fetch(`https://github.com/trycua/cua/releases/download/${release.tag}/${name}`, {
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw new Error(`Cua Perception download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if ((size !== undefined && bytes.length !== size) || createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new Error(`Cua Perception checksum or size mismatch for ${target}.`);
    }
    writeFileSync(join(work, name), bytes);
  }
  const destination = join(packageRoot, 'platforms', `cua-perception-${target}`, 'artifacts');
  mkdirSync(destination, { recursive: true });
  cpSync(work, destination, { recursive: true });
  process.stdout.write(`${destination}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
