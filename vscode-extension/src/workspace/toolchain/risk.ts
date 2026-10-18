import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 风险分级与风险研判。放行只看这里给出的等级和研判结果，两种模式只是同一张表的不同列：
 * R0 只读 / R1 项目内常规 / R2 删除类 / R3 项目外 / R4 禁止。
 * 研判是静态规则匹配：能提示明显可疑的写法，不能保证识别所有恶意代码。
 */

export type RiskLevel = 0 | 1 | 2 | 3 | 4;
export type WarningLevel = 'warn' | 'high';
export type RiskWarning = { level: WarningLevel; reason: string; evidence?: string };

type Rule = { level: WarningLevel; reason: string; pattern: RegExp };

const RULES: Rule[] = [
  // 高度可疑：几乎没有正当用途
  { level: 'high', reason: '疑似反弹 shell（把命令行交给远程控制）', pattern: /(?:\bnc(?:at)?\b[^\n]*\s-[ec]\b|\/dev\/tcp\/|bash\s+-i\s*>&|socket\.connect\([^)]*\)[\s\S]{0,200}(?:spawn|exec)\(\s*['"](?:\/bin\/)?(?:sh|bash|cmd(?:\.exe)?|powershell)\b)/i },
  { level: 'high', reason: '读取 SSH 私钥或云服务凭据', pattern: /(?:\.ssh[\\/](?:id_[a-z0-9]+|identity)\b|\.aws[\\/]credentials|\.azure[\\/]|\.kube[\\/]config|\.docker[\\/]config\.json|\.git-credentials|\.netrc\b|Login Data|Local State|\\Microsoft\\(?:Credentials|Vault|Protect)\b|Keychains?[\\/])/i },
  { level: 'high', reason: '疑似 Python 反弹 shell（把命令行交给远程控制）', pattern: /(?:os\.dup2\(\s*\w+\.fileno\(\)|pty\.spawn\(\s*['"](?:\/bin\/)?(?:sh|bash)|socket\.socket\([\s\S]{0,300}\.connect\([\s\S]{0,300}subprocess\.(?:call|Popen|run)\(\s*\[?\s*['"](?:\/bin\/)?(?:sh|bash|cmd(?:\.exe)?|powershell))/i },
  { level: 'high', reason: '把全部环境变量序列化（常见于窃取令牌）', pattern: /(?:json\.dumps|str|repr)\(\s*(?:dict\(\s*)?os\.environ\s*\)?\s*\)/ },
  { level: 'high', reason: '把全部环境变量序列化（常见于窃取令牌）', pattern: /JSON\.stringify\(\s*process\.env\s*\)|Object\.(?:entries|keys)\(\s*process\.env\s*\)[\s\S]{0,120}(?:fetch|https?\.request|axios|\.post\()/i },
  // 可疑：有正当用途，但需要你看一眼
  { level: 'warn', reason: '下载远程内容并直接执行', pattern: /(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python3?)\b|(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i },
  { level: 'warn', reason: '执行编码后的命令', pattern: /powershell(?:\.exe)?\b[^\n]*\s-(?:e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sh|bash)\b/i },
  { level: 'warn', reason: '解码后动态执行代码', pattern: /\b(?:exec|eval)\(\s*(?:compile\(\s*)?(?:base64\.b64decode|codecs\.decode|zlib\.decompress|marshal\.loads|bytes\.fromhex)\(/ },
  { level: 'warn', reason: '下载远程内容并直接执行', pattern: /\bexec\(\s*(?:requests\.get|urllib\.request\.urlopen|urlopen|httpx\.get)\(/ },
  { level: 'warn', reason: '删除用户目录或项目外的文件', pattern: /shutil\.rmtree\(\s*(?:os\.path\.expanduser\(|Path\.home\(\)|['"](?:~|\/(?!tmp)|[A-Za-z]:\\))/ },
  { level: 'warn', reason: '解码后动态执行代码', pattern: /(?:eval|Function|execSync|exec)\s*\(\s*(?:Buffer\.from\([^)]*['"]base64['"]\)|atob\()/i },
  { level: 'warn', reason: '写入开机启动或 shell 配置', pattern: /(?:Start Menu[\\/]Programs[\\/]Startup|\\CurrentVersion\\Run\b|LaunchAgents|LaunchDaemons|\/etc\/cron|crontab\s+-|>>\s*~?\/?\.(?:bashrc|zshrc|profile|bash_profile))/i },
  { level: 'warn', reason: '修改系统目录', pattern: /(?:[Cc]:\\Windows\\System32|\/etc\/(?:hosts|passwd|sudoers)|\/usr\/(?:local\/)?bin\/)[^\n]*(?:>|copy|cp\s|mv\s|writeFile)/i },
];

// 超长单行里夹带大段编码字符串，是常见的混淆写法。
const OBFUSCATED = /[A-Za-z0-9+/=]{600,}|(?:\\x[0-9a-f]{2}){80,}/i;
const MAX_SCAN_CHARS = 300_000;

function snippet(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', index) + 1);
  const end = text.indexOf('\n', index);
  const line = text.slice(start, end < 0 ? undefined : end).trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** 扫描一段文本；source 用于在提示里标出出处（脚本名或文件:行号）。 */
export function scanText(text: string, source: string): RiskWarning[] {
  const body = text.slice(0, MAX_SCAN_CHARS);
  const warnings: RiskWarning[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(body);
    if (!match) continue;
    warnings.push({ level: rule.level, reason: rule.reason, evidence: `${source}:${lineNumber(body, match.index)} · ${snippet(body, match.index)}` });
  }
  const obfuscated = OBFUSCATED.exec(body);
  if (obfuscated) {
    warnings.push({ level: 'warn', reason: '代码中有大段编码或混淆内容', evidence: `${source}:${lineNumber(body, obfuscated.index)}` });
  }
  return warnings;
}

/** 脚本直接调用的本地入口文件（node xxx.js / tsx xxx.ts 等），限制在 baseDir 之内。 */
export function scriptEntryFiles(body: string, baseDir: string): string[] {
  const files: string[] = [];
  for (const match of body.matchAll(/\b(?:node|tsx|ts-node|bun)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w@./\\-]+\.(?:[cm]?js|[cm]?ts))\b/g)) {
    const absolute = path.resolve(baseDir, match[1]);
    if (absolute.startsWith(baseDir + path.sep) && !absolute.split(path.sep).includes('node_modules')) files.push(absolute);
  }
  return [...new Set(files)].slice(0, 10);
}

export async function scanFiles(files: string[], baseDir: string): Promise<RiskWarning[]> {
  const warnings: RiskWarning[] = [];
  for (const file of files) {
    let text: string;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    warnings.push(...scanText(text, path.relative(baseDir, file).split(path.sep).join('/')));
  }
  return warnings;
}

/** 合并同一原因，最多保留 6 条，高危排前。 */
export function mergeWarnings(warnings: RiskWarning[]): RiskWarning[] {
  const seen = new Set<string>();
  return warnings
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1))
    .filter((warning) => {
      const key = `${warning.level}|${warning.reason}|${warning.evidence ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

export function highestWarning(warnings: RiskWarning[] | undefined): WarningLevel | undefined {
  if (!warnings?.length) return undefined;
  return warnings.some((warning) => warning.level === 'high') ? 'high' : 'warn';
}
