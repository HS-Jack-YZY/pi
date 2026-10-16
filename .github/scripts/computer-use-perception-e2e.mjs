#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '../../packages/pi-computer-use');
const release = JSON.parse(readFileSync(new URL('./fixtures/computer-use-perception-release.json', import.meta.url), 'utf8'));
const { CuaDriverClient, resolveDriverLayout } = await import(
  pathToFileURL(path.join(packageRoot, 'dist/index.js')).href
);
const work = mkdtempSync(path.join(tmpdir(), 'pi-computer-use-perception-e2e-'));
process.env.CUA_DRIVER_RS_HOME = path.join(work, 'driver-home');
const artifact = release.targets[`${process.platform}-${process.arch}`];
const artifactDir = process.env.CUA_DRIVER_PERCEPTION_DIR ?? path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'cua-perception');
const catalog = path.resolve(artifactDir, artifact.catalog);
process.env.CUA_DRIVER_PERCEPTION_CATALOG = catalog;
const { binaryPath } = resolveDriverLayout({ mode: 'bundled' });
const cli = (args) => execFileSync(binaryPath, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
});
const image = path.join(import.meta.dirname, 'fixtures/computer-use-perception.png');
const capture = path.join(work, 'capture.json');
// Local-image provenance deliberately grants no live capture or input authority.
writeFileSync(capture, JSON.stringify({ source: { kind: 'window', pid: process.pid, window_id: 1 } }));
const parseArgs = ['perception', 'parse', '--image', image, '--capture', capture, '--json'];
const client = new CuaDriverClient({ mode: 'bundled' });
try {
  assert.equal(JSON.parse(cli(['extension', 'status', 'cua-perception', '--json'])).installed, false);
  assert.throws(() => cli(parseArgs), (error) => {
    assert.equal(JSON.parse(error.stdout).error.code, 'not_installed');
    return true;
  });
  let preview = await client.callTool('install_extension', { name: 'perception' });
  const permissionBlocked = process.platform === 'darwin' && preview.isError === true &&
    preview.content.some(({ type, text }) => type === 'text' && text.startsWith('permissions_pending:'));
  if (permissionBlocked) {
    // shortcut: hosted macOS lacks TCC grants; use signed CLI until upstream exempts extension lifecycle from the gate.
    preview = { structuredContent: JSON.parse(cli(['extension', 'inspect', 'cua-perception', '--catalog', catalog, '--json'])) };
  }
  assert.notEqual(preview.isError, true, `upstream catalog preview failed: ${JSON.stringify(preview)}`);
  assert.equal(preview.structuredContent.version, release.version);
  assert.equal(preview.structuredContent.trust, 'publisher-verified');
  assert.equal(preview.structuredContent.installed, false);
  assert(preview.structuredContent.artifact_source.includes(artifact.archive));
  if (permissionBlocked) {
    cli(['extension', 'install', 'cua-perception', '--catalog', catalog]);
  } else {
    const installed = await client.callTool('install_extension', { name: 'perception', confirm: true });
    assert.notEqual(installed.isError, true, `confirmed installation failed: ${JSON.stringify(installed)}`);
    assert.equal(installed.structuredContent.installed, true);
  }
  const status = JSON.parse(cli(['extension', 'status', 'cua-perception', '--self-test', '--json']));
  assert.equal(status.installed, true);
  assert.equal(status.active_version, release.version);
  assert.equal(status.healthy, true);
  assert.equal(status.trust, 'publisher-verified');

  const parsed = JSON.parse(cli(parseArgs));
  assert.equal(parsed.schema, 'cua.visual_regions_v1');
  assert.equal(parsed.local_input.action_eligible, false);
  assert.equal(parsed.local_input.action_authority, 'none');
  assert.equal(parsed.parser.extension_version, release.version);
  const text = parsed.regions.filter(({ kind }) => kind === 'text').map(({ text }) => text).join(' ');
  assert.match(text, /PERCEPTION CHECK/i);
  assert.match(text, /VALIDATION 7391/i);
  for (const { bounds } of parsed.regions) {
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0);
    assert(bounds.x + bounds.width <= 1000 && bounds.y + bounds.height <= 300);
  }
  process.stdout.write(`Cua Perception ${release.version}: upstream artifacts, signed ${permissionBlocked ? 'CLI' : 'MCP'} installation, self-test and real OCR verified.\n`);
} finally {
  await client.close();
  rmSync(work, { recursive: true, force: true });
}
