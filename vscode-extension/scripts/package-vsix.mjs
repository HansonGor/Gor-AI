// 打包 .vsix：插件依赖本地的 ../workspace-core（file: 链接），vsce 会把链接目录外的文件也算进去，
// 因此先用 esbuild 把扩展代码、公共工作区核心与 ws 打成单个 extension.js，再在临时目录里只放发布需要的文件，
// 以 --no-dependencies 打包。日常开发仍用 tsc -b 输出的 out/，不受影响。
// 用法：npm run package:vsix [-- --out <file.vsix>]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const outIndex = process.argv.indexOf('--out');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join(root, `${manifest.name}-${manifest.version}.vsix`));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（退出码 ${result.status}）`);
}

// 1. 构建聊天页资源与扩展 TypeScript（含公共工作区核心）
run('npm', ['run', 'vscode:prepublish']);

// 2. 在临时目录组装发布内容
const stage = mkdtempSync(join(tmpdir(), 'gor-vsix-'));
try {
  await build({
    entryPoints: [join(root, 'out', 'extension.js')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node18',
    outfile: join(stage, 'dist', 'extension.js'),
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    sourcemap: false, logLevel: 'warning',
  });
  for (const folder of ['media', 'resources']) cpSync(join(root, folder), join(stage, folder), { recursive: true });
  const { devDependencies, dependencies, scripts, ...rest } = manifest;
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ ...rest, main: './dist/extension.js' }, null, 2)}\n`);
  writeFileSync(join(stage, 'README.md'), `# ${manifest.displayName ?? manifest.name}\n\n${manifest.description ?? ''}\n`);
  mkdirSync(dirname(output), { recursive: true });

  // 3. 打包（vsce 来自本插件的开发依赖）
  const vsce = join(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  run(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', output], stage);
  console.log(`[Gor] 已生成 ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
