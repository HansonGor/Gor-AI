import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.resolve(extensionRoot, '../Web');
const outputRoot = path.join(extensionRoot, 'media', 'chat');
const buildSignalPath = path.join(outputRoot, '.gor-build-complete');
const rootFiles = new Set([
  'package.json',
  'index.html',
  'vscode.html',
  'preview-runtime.html',
  'vite.vscode.config.js',
  'vite.preview-runtime.config.js',
  'vite.config.js',
  'tailwind.config.js',
  'postcss.config.js',
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
]);

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let buildTimer;
let isBuilding = false;
let buildQueued = false;
const watchers = [];
let activeBuildProcess;

function runBuild() {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : npmCommand;
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run build:extension']
      : ['run', 'build:extension'];
    const child = spawn(command, args, {
      cwd: webRoot,
      stdio: 'inherit',
    });
    activeBuildProcess = child;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      activeBuildProcess = undefined;
      if (code === 0) resolve();
      else reject(new Error(`Webview build exited with ${signal || code}`));
    });
  });
}

async function buildWebview() {
  if (isBuilding) {
    buildQueued = true;
    return false;
  }

  isBuilding = true;
  let succeeded = false;
  console.log('[Gor Watch] Building VS Code Webview...');
  try {
    await runBuild();
    await writeFile(buildSignalPath, String(Date.now()), 'utf8');
    console.log('[Gor Watch] Webview build complete.');
    succeeded = true;
  } catch (error) {
    console.error(`[Gor Watch] Build failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    isBuilding = false;
    if (buildQueued) {
      buildQueued = false;
      scheduleBuild(0);
    }
  }
  return succeeded;
}

function scheduleBuild(delay = 450) {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => void buildWebview(), delay);
}

function addWatcher(directory, recursive, shouldBuild = () => true) {
  const watcher = watch(directory, { recursive }, (_eventType, filename) => {
    const changedPath = filename?.toString() ?? '';
    if (shouldBuild(changedPath)) scheduleBuild();
  });
  watcher.on('error', (error) => {
    console.error(`[Gor Watch] File watcher error: ${error.message}`);
  });
  watchers.push(watcher);
}

function shutdown() {
  clearTimeout(buildTimer);
  watchers.forEach((watcher) => watcher.close());
  activeBuildProcess?.kill('SIGINT');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

addWatcher(path.join(webRoot, 'src'), true);
addWatcher(path.join(webRoot, 'public', 'images'), true);
addWatcher(webRoot, false, (filename) => rootFiles.has(filename));
console.log('[Gor Watch] Initial build started.');
try {
  const initialBuildSucceeded = await buildWebview();
  if (!initialBuildSucceeded) process.exit(1);
} catch (error) {
  console.error(`[Gor Watch] Initial build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log('[Gor Watch] Watching Web/src and Web/public/images for changes.');
