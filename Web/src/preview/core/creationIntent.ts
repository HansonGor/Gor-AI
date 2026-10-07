/** A generation request creates an isolated project; revisions keep its identity. */
export function isNewPreviewProjectRequest(text: string): boolean {
  if (/(?:怎么|如何|为什么|是否)/i.test(text) && !/(?:请|帮我|直接|给我).{0,12}(?:生成|新建|创建|做|开发)/i.test(text)) return false;
  if (/(?:不要|不用|别|不需要|取消|先不)\s*(?:帮我|给我)?\s*(?:生成|新建|创建|搭建|开发|制作|做|写)/i.test(text)) return false;
  if (/(?:修改|优化|修复|完善|继续|当前|这个|已有|原有|现有)/i.test(text) && !/(?:新建|新的|另一个|另外一个|重新生成)/i.test(text)) return false;
  return /(?:生成|新建|创建|搭建|开发|制作|建一个|建个|做一个|做个|写一个|写个)/i.test(text)
    && /(?:react|html|网页|网站|页面|landing|website|应用|项目|demo|游戏|贪吃蛇|扫雷|待办|todo|清单|表单|仪表盘|博客|小工具|calculator|3d|三维|模型|glb)/i.test(text);
}
