// 桌面端开发模式：TypeScript 监听编译，主进程代码编译成功后自动重启窗口；
// 窗口直接加载 Web 开发服务器（默认 http://localhost:5173），前端改动由 Vite 热更新。
// 关闭窗口即结束；编译出错时保留当前窗口并打印错误，不重启。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const tscPath = require.resolve('typescript/bin/tsc');
const devUrl = process.env.GOR_DESKTOP_DEV_URL || 'http://localhost:5173';

let electron = null;
let restarting = false;
let shuttingDown = false;

const log = (message) => console.log(`[gor-desktop dev] ${message}`);

async function waitForDevServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(devUrl)).ok) return true;
    } catch { /* 开发服务器还没起来 */ }
    if (attempt === 0) log(`等待 Web 开发服务器 ${devUrl} …（未启动请运行 npm --prefix ../Web run dev）`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log(`仍未连上 ${devUrl}，先打开窗口；开发服务器就绪后在窗口里刷新即可`);
  return false;
}

function startElectron() {
  electron = spawn(electronPath, ['.', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, GOR_DESKTOP_DEV_URL: devUrl },
  });
  electron.on('exit', (code) => {
    electron = null;
    if (restarting || shuttingDown) return;
    // 用户关闭了窗口：结束整个开发会话
    log('窗口已关闭，结束开发模式');
    shutdown(code ?? 0);
  });
}

function restartElectron() {
  if (!electron) {
    startElectron();
    return;
  }
  restarting = true;
  electron.once('exit', () => {
    restarting = false;
    startElectron();
  });
  electron.kill();
}

function shutdown(code) {
  shuttingDown = true;
  electron?.kill();
  tsc.kill();
  process.exit(code);
}

await waitForDevServer();

let started = false;
const tsc = spawn(process.execPath, [tscPath, '-p', '.', '--watch', '--preserveWatchOutput'], { cwd: root });
tsc.stdout.setEncoding('utf8');
tsc.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  // tsc 每轮编译结束都会打印 "Found N errors. Watching for file changes."
  const match = /Found (\d+) errors?\. Watching for file changes/.exec(chunk);
  if (!match) return;
  if (Number(match[1]) > 0) {
    log('编译有错误，保留当前窗口，修正后自动重启');
    return;
  }
  if (!started) {
    started = true;
    log('编译完成，启动窗口');
    startElectron();
  } else {
    log('主进程代码已更新，重启窗口');
    restartElectron();
  }
});
tsc.stderr.pipe(process.stderr);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
