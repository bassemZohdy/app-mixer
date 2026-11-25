// FEAT-017: run the default test suite under Node's built-in coverage, report a line and branch figure per workspace package,
// and exit non-zero when any package falls below its threshold. The thresholds sit just under the measured baseline so a
// regression in any package fails the run instead of silently eroding coverage. The opt-in tests (PostgreSQL, browser, Docker)
// stay skipped, so the figures describe the default suite that every change runs.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testPackages = ['core', 'cli', 'web', 'native', 'agent'];
/** Minimum line and branch coverage, in percent, per package; shared is covered through the other packages' tests. */
const thresholds = {
  core: { lines: 88, branches: 88 },
  cli: { lines: 97, branches: 78 },
  web: { lines: 94, branches: 85 },
  native: { lines: 73, branches: 90 },
  agent: { lines: 64, branches: 85 },
  shared: { lines: 92, branches: 90 }
};
const configured = process.env.APP_MIXER_TEST_CONCURRENCY;
if (configured !== undefined && (!/^[1-9]\d?$/.test(configured) || Number(configured) > 32)) {
  console.error('APP_MIXER_TEST_CONCURRENCY must be an integer from 1 to 32');
  process.exit(1);
}
const concurrency = configured ?? (process.platform === 'win32' ? Math.min(8, availableParallelism()) : '8');
const files = testPackages.flatMap(name => {
  const folder = join(root, 'packages', name, 'test');
  return readdirSync(folder)
    .filter(entry => entry.endsWith('.test.mjs'))
    .map(entry => join('packages', name, 'test', entry))
    .sort();
});
const directory = mkdtempSync(join(tmpdir(), 'app-mixer-coverage-'));
const report = join(directory, 'coverage.lcov');
const coverageFlags = [
  '--test',
  '--experimental-test-coverage',
  // Node 22 counts the test files themselves; Node 24 does not. Excluding them keeps the figure the same on both.
  '--test-coverage-exclude=packages/*/test/**',
  `--test-concurrency=${concurrency}`,
  '--test-reporter=lcov',
  `--test-reporter-destination=${report}`,
  '--test-reporter=dot',
  '--test-reporter-destination=stdout',
  ...files
];
const child = spawn(process.execPath, coverageFlags, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', error => {
  console.error(error.message);
  rmSync(directory, { recursive: true, force: true });
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`Coverage needs the test suite to pass first (exit ${code ?? signal}).`);
    rmSync(directory, { recursive: true, force: true });
    process.exit(1);
  }
  const measured = parseLcov(report);
  rmSync(directory, { recursive: true, force: true });
  const rows = [...testPackages, 'shared'].map(name => {
    const totals = measured.get(name);
    if (!totals || totals.lines === 0) return { name, lines: null, branches: null, threshold: thresholds[name], covered: false };
    const lines = (100 * totals.lineHits) / totals.lines;
    const branches = totals.branches === 0 ? null : (100 * totals.branchHits) / totals.branches;
    return { name, lines, branches, threshold: thresholds[name], covered: lines >= thresholds[name].lines && (branches === null || branches >= thresholds[name].branches) };
  });
  console.log('\nCoverage (line %, branch %) per package, thresholds in parentheses:');
  for (const row of rows) {
    const figure = value => (value === null ? '  n/a' : value.toFixed(2).padStart(6));
    const branchThreshold = row.threshold.branches === null ? ' n/a' : String(row.threshold.branches).padStart(4);
    const lineThreshold = String(row.threshold.lines).padStart(4);
    const state = row.covered ? 'ok' : 'BELOW THRESHOLD';
    console.log(`  ${row.name.padEnd(8)} lines ${figure(row.lines)} (${lineThreshold})  branches ${figure(row.branches)} (${branchThreshold})  ${state}`);
  }
  const below = rows.filter(row => !row.covered);
  if (below.length > 0) {
    console.error(`\n${below.map(row => row.name).join(', ')} fell below the coverage threshold.`);
    process.exit(1);
  }
});

/** Sum the LCOV line and branch totals per workspace package. */
function parseLcov(path) {
  const totals = new Map();
  let current, name;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      name = /^packages[/\\]([a-z]+)[/\\]/.exec(line.slice(3))?.[1];
      current = undefined;
      if (name !== undefined) {
        if (!totals.has(name)) totals.set(name, { lines: 0, lineHits: 0, branches: 0, branchHits: 0 });
        current = totals.get(name);
      }
    } else if (current !== undefined) {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const key = line.slice(0, separator),
        value = Number(line.slice(separator + 1));
      if (key === 'LF') current.lines += value;
      else if (key === 'LH') current.lineHits += value;
      else if (key === 'BRF') current.branches += value;
      else if (key === 'BRH') current.branchHits += value;
    }
  }
  return totals;
}
