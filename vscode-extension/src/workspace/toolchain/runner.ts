import { spawn, type ChildProcess } from 'node:child_process';

/** 通用执行器：不经过 shell、环境变量白名单、超时、取消（结束进程树）、输出截断与脱敏。 */

// 回执会进入模型上下文，只保留开头与结尾；完整输出实时写入「Gor 工具链」输出面板。
export const OUTPUT_HEAD_CHARS = 4_000;
export const OUTPUT_TAIL_CHARS = 8_000;

// 只把运行工具链所必需的变量交给子进程；令牌、密钥类变量一律不继承。
const ENV_ALLOWLIST = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile',
  'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)',
  'commonprogramfiles', 'number_of_processors', 'processor_architecture', 'os', 'lang', 'lc_all', 'lc_ctype',
  'shell', 'user', 'username', 'logname', 'xdg_cache_home', 'xdg_config_home', 'xdg_data_home',
  // 安装依赖需要沿用用户的代理、镜像与证书配置（带凭据的地址会在输出中脱敏）
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'npm_config_registry', 'npm_config_proxy',
  'npm_config_https_proxy', 'npm_config_strict_ssl', 'npm_config_cache', 'yarn_registry', 'corepack_npm_registry',
  'node_extra_ca_certs',
  // Python：pip / uv 的镜像与证书（带凭据的地址会在输出中脱敏）
  'pip_index_url', 'pip_extra_index_url', 'pip_trusted_host', 'pip_cert', 'uv_index_url', 'uv_extra_index_url',
  'requests_ca_bundle', 'ssl_cert_file',
]);
const SECRET_NAME = /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|auth)/i;

export function buildChildEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (!ENV_ALLOWLIST.has(key.toLowerCase()) || SECRET_NAME.test(key)) continue;
    env[key] = value;
  }
  const merged: Record<string, string> = { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_update_notifier: 'false' };
  // Windows 的环境变量不区分大小写（Path / PATH）：同名变量只保留一份，以 extra 为准。
  for (const [key, value] of Object.entries(extra)) {
    for (const existing of Object.keys(merged)) if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    merged[key] = value;
  }
  return merged;
}

/** 读取当前进程 PATH（不区分大小写）。 */
export function currentPath(source: NodeJS.ProcessEnv = process.env): string {
  const key = Object.keys(source).find((name) => name.toLowerCase() === 'path');
  return key ? source[key] ?? '' : '';
}

/** 去掉输出里常见的凭据：URL 中的用户名/令牌、Bearer、常见令牌前缀，以及 KEY=VALUE 形式的密钥。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1')
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, '$1[已隐藏]')
    .replace(/\bbearer\s+[a-z0-9._~+/-]{12,}=*/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,})\b/g, '[已隐藏]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, '$1[已隐藏]');
}

/** 保留开头和结尾，丢弃中间；用于防止海量输出撑爆回执。 */
export class OutputBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;

  append(chunk: string): void {
    if (this.head.length < OUTPUT_HEAD_CHARS) {
      const room = OUTPUT_HEAD_CHARS - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > OUTPUT_TAIL_CHARS) {
      this.dropped += this.tail.length - OUTPUT_TAIL_CHARS;
      this.tail = this.tail.slice(-OUTPUT_TAIL_CHARS);
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  text(): string {
    const middle = this.dropped ? `\n…（中间省略 ${this.dropped} 个字符）…\n` : '';
    return redactSecrets(this.head + middle + this.tail);
  }
}

export type ProcessOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type RunHandle = { cancel: () => void; done: Promise<ProcessOutcome> };

export type RunOptions = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
};

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill /T 结束整个进程树（npm 会再派生 shell 和测试进程）。
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function runProcess(options: RunOptions): RunHandle {
  const started = Date.now();
  const stdout = new OutputBuffer();
  const stderr = new OutputBuffer();
  let timedOut = false;
  let cancelled = false;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<ProcessOutcome>((resolve) => {
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode, timedOut, cancelled, spawnError, durationMs: Date.now() - started,
        stdout: stdout.text(), stderr: stderr.text(),
        stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
      });
    };
    if (!options.argv.length || !options.argv[0]) {
      finish(null, '命令为空。');
      return;
    }
    try {
      child = spawn(options.argv[0], options.argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    let settled = false;
    const settle = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      finish(exitCode, spawnError);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout.append(chunk); options.onOutput?.(chunk, 'stdout'); });
    child.stderr?.on('data', (chunk: string) => { stderr.append(chunk); options.onOutput?.(chunk, 'stderr'); });
    child.on('error', (error) => settle(null, error.message));
    child.on('close', (code) => settle(timedOut || cancelled ? null : code));
    // timeoutMs <= 0 表示常驻进程：不设超时，由止令或扩展退出时结束。
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child) killTree(child);
      }, options.timeoutMs);
    }
  });

  return {
    done,
    cancel: () => {
      if (cancelled || timedOut) return;
      cancelled = true;
      if (child) killTree(child);
    },
  };
}
