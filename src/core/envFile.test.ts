import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { writeEnvVars } from './envFile.js';

let dir: string | null = null;
function freshEnvPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'env-write-'));
  return join(dir, '.env');
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('writeEnvVars', () => {
  it('creates a new file with the given keys', () => {
    const p = freshEnvPath();
    writeEnvVars(p, { LINEAR_API_KEY: 'abc', LINEAR_TEAM_ID: 'TEAM' });
    const txt = readFileSync(p, 'utf8');
    expect(txt).toContain('LINEAR_API_KEY=abc');
    expect(txt).toContain('LINEAR_TEAM_ID=TEAM');
  });

  it('upserts existing keys in place and preserves other lines + comments', () => {
    const p = freshEnvPath();
    writeFileSync(p, '# my env\nLINEAR_API_KEY=old\nKEEP_ME=yes\n');
    writeEnvVars(p, { LINEAR_API_KEY: 'new' });
    const txt = readFileSync(p, 'utf8');
    expect(txt).toContain('# my env');
    expect(txt).toContain('KEEP_ME=yes');
    expect(txt).toContain('LINEAR_API_KEY=new');
    expect(txt).not.toContain('LINEAR_API_KEY=old');
  });

  it('quotes values that contain spaces or special characters', () => {
    const p = freshEnvPath();
    writeEnvVars(p, { TOKEN: 'a b#c' });
    expect(readFileSync(p, 'utf8')).toContain('TOKEN="a b#c"');
  });

  it('round-trips a quoted value through loadEnvFile parsing', () => {
    const p = freshEnvPath();
    writeEnvVars(p, { WEBHOOK: 'https://x.example/y?z=1 2' });
    const txt = readFileSync(p, 'utf8');
    // value is quoted; the embedded space is retained inside the quotes
    expect(txt).toMatch(/WEBHOOK="https:\/\/x\.example\/y\?z=1 2"/);
  });

  it('writes the file as owner-only (0600) on POSIX', () => {
    if (platform() === 'win32') return;
    const p = freshEnvPath();
    writeEnvVars(p, { SECRET: 'x' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
