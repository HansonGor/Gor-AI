import {
  PencilLine, Search, FileSearch, FolderSearch, ListTodo, FilePenLine,
  GitBranch, Terminal, Bug, ListChecks, Hammer, type LucideIcon,
} from 'lucide-react';
import type { ThinkingRound } from './thinking';

const icons = { PencilLine, Search, FileSearch, FolderSearch, ListTodo, FilePenLine, GitBranch, Terminal, Bug, ListChecks, Hammer };
type IconName = keyof typeof icons;

// Exact names from execution events take precedence over descriptive titles.
const toolIcons: Record<string, IconName> = {
  web_search: 'Search', web_reader: 'Search', search_github_code: 'Search', get_weather: 'Search',
  read_project_file: 'FileSearch', read_preview_file: 'FileSearch',
  search_project_code: 'FileSearch', search_preview_code: 'FileSearch',
  list_project_files: 'FolderSearch', list_preview_files: 'FolderSearch',
  patch_project_file: 'FilePenLine', patch_preview_file: 'FilePenLine', edit_project_file: 'FilePenLine',
  write_project_file: 'FilePenLine', write_preview_file: 'FilePenLine',
  batch_patch_project_files: 'FilePenLine', batch_patch_preview_files: 'FilePenLine',
  create_project_file: 'FilePenLine', delete_project_file: 'FilePenLine',
  create_project_directory: 'FilePenLine', delete_project_directory: 'FilePenLine',
  run_command: 'Terminal', execute_command: 'Terminal', execute_script: 'Terminal',
  run_tests: 'ListChecks', build_project: 'Hammer',
  git_status: 'GitBranch', git_commit: 'GitBranch', git_push: 'GitBranch',
  run_toolchain_action: 'Terminal', list_toolchains: 'ListChecks',
};

const titleIcons: ReadonlyArray<[RegExp, IconName]> = [
  [/施行结果/, 'Terminal'],
  [/错误|调试|冲突|构建问题|排查|debug|error|conflict/i, 'Bug'],
  [/提交结果|推送结果|Git 状态|git commit|git push/i, 'GitBranch'],
  [/依赖|模块关系|dependencies|dependency/i, 'GitBranch'],
  [/项目结构|文件结构|目录结构|检查目录|project structure/i, 'FolderSearch'],
  [/测试|验证|类型检查|TypeScript 检查|test|verify/i, 'ListChecks'],
  [/构建|编译|build|compile/i, 'Hammer'],
  [/命令|脚本|终端|command|script|terminal/i, 'Terminal'],
  [/方案|规划|步骤|plan/i, 'ListTodo'],
  [/读取|检查源码|文件读取|read|source code/i, 'FileSearch'],
  [/修改|编辑|写入|创建文件|删除文件|edit|patch|write/i, 'FilePenLine'],
  [/搜索|检索|联网|查询|search|browse/i, 'Search'],
];

export function getThinkingIcon(round: Pick<ThinkingRound, 'title' | 'toolName'>): { name: IconName; Icon: LucideIcon } {
  if (!round.title?.trim() || /^思考中(?:…|\.\.\.)?$/.test(round.title.trim())) return { name: 'PencilLine', Icon: PencilLine };
  const tool = round.toolName && Object.prototype.hasOwnProperty.call(toolIcons, round.toolName) ? toolIcons[round.toolName] : undefined;
  const name = tool || titleIcons.find(([pattern]) => pattern.test(round.title ?? ''))?.[1] || 'PencilLine';
  return { name, Icon: icons[name] };
}
