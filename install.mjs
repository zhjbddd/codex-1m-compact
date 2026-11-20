import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = 'codex-1m-compact';

function parseTargetDir(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--target=')) {
      return resolve(argv[i].slice('--target='.length));
    }
    if (argv[i] === '--target' && argv[i + 1]) {
      return resolve(argv[i + 1]);
    }
  }
  return join(homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);
}

const RUNTIME_FILES = [
  'plugin.json',
  'hooks.json',
  'mcp_config.json',
  'README.md',
];

const RUNTIME_DIRS = [
  'assets',
  'rules',
  'skills',
  'lib',
  'scripts',
  'mcp',
  'sidecars',
];

const targetDir = parseTargetDir(process.argv.slice(2));
mkdirSync(targetDir, { recursive: true });

for (const file of RUNTIME_FILES) {
  const src = join(__dirname, file);
  const dest = join(targetDir, file);
  if (!existsSync(src)) {
    throw new Error(`Missing required plugin file: ${src}`);
  }
  cpSync(src, dest, { force: true });
}

for (const dir of RUNTIME_DIRS) {
  const src = join(__dirname, dir);
  const dest = join(targetDir, dir);
  if (!existsSync(src)) {
    throw new Error(`Missing required plugin directory: ${src}`);
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

console.log(`[codex-1m-compact] Installed runtime plugin bundle to: ${targetDir}`);
