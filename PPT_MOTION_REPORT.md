# Gor PPT Motion Design System 验收报告

日期：2026-09-30。此报告对应本地工作区的实现与 `.runlogs/motion-acceptance/` 的测试夹具；不把静态截图当作动画播放证明。

## 实现、范围与能力（对应需求 1–32）

| # | 项目 | 真实结果 |
| --- | --- | --- |
| 1 | 修改文件 | `Server/agent/agent.py`、`prompts.py`、`Server/routes/chat.py`、`download.py`、`Server/tools/presentation.py`、`presentation_design.py`、`presentation_renderer.py`、`pexels.py`、`Server/tests/test_presentation_design.py`、`test_presentation_pexels.py`、`Web/src/api/chat.ts`、`types.ts`、`Web/src/components/ChatBox/PreviewWorker.tsx`、`Web/src/components/preview/PresentationPreview.tsx/.less`、`Web/src/preview/core/presentationSnapshot.ts`、`Web/scripts/preview-core.test.ts` 与 `project.md`。工作区原有其他修改未清理。 |
| 2 | 新文件 | `Server/tools/presentation_motion.py`、`presentation_motion_renderer.py`、`presentation_critique.py`、`presentation_render.py`、`Server/tests/test_presentation_motion.py`、`test_download_preview.py`、`presentation_samples.py`、`generate_motion_acceptance.py`、`verify_motion_powerpoint.ps1`、`Web/src/preview/core/presentationMotion.ts`、`Web/scripts/motion-smoke.html/.tsx`、本报告。 |
| 3 | Motion Schema | 保持 `PresentationDesign v1.0`；`motionLanguage` 在演示级，`transition`、`animations`、`animationGroups`、`animationTimeline`、`persistentElements`、`motionDisabled` 在页级。Code 中的 `/presentation.json` 是唯一时间轴源。 |
| 4 | Motion Language | `minimal`、`professional`、`cinematic`、`editorial`、`dynamic`、`data-driven`，配合能量、转场/入场家族、播放方式、距离、时长系数与组数预算；从既有设计 DNA 推断默认值。 |
| 5 | Animation Director | 确定性按页面类型、叙事角色和语义组排列，再校验与修复，不由模型直接写 PPTX XML。 |
| 6 | Slide Transition | `none`、`fade`、`push`、`wipe` 写入原生 PPTX；Morph 不原生输出，回退 fade。Web 使用相同配置作模拟转场。 |
| 7 | Entrance | 原生 `appear`、`fade`、`rise`、`wipe`、`fly`、`zoom`；网页对应模拟。默认短距离、有限时长，不从屏外大幅飞入。 |
| 8 | Emphasis | 原生 `grow`、`pulse`、`colorEmphasis`；后者仅用于文字，其他对象回退 pulse。 |
| 9 | Exit | 原生 `fadeOut`；默认导演不滥用退出。 |
| 10 | Trigger | `withPrevious`、`afterPrevious`、`onClick`。默认自动，点按仅在显式请求或既有旧模式；点击段在 PPTX 与 Web 各自按 `clickIndex` 播放。 |
| 11 | Timeline | 每条 cue 有 target、effect、trigger、order、start、duration、delay、clickIndex、direction、distance；`start` 为当前点击段相对时间。 |
| 12 | Choreography | 封面主图→标题→辅助；大数字→标签→解释；图表整体→重点标注→结论；对比左右依次、卡片/步骤 stagger；quote/breath 保持克制。 |
| 13 | Duration token | fast=0.24s、normal=0.42s、slow=0.72s，且可经 0.5–1.5 倍缩放，最终最长限制 0.9s。 |
| 14 | Stagger | fast=80ms、normal=120ms、slow=180ms；按组内元素统一设定。 |
| 15 | Motion distance | micro=页尺寸 1.2%、short=2.5%、medium=4.5%；Web 使用页面像素距离，不按单个元素自身宽高计算。 |
| 16 | Animation budget | 全局最大 5 组，密集页最多 4 组，停顿页 1 组；超出组保持静态。 |
| 17 | Animation Group | 以语义目标绑定多个原生形状或 DOM 包装层；卡片面板与文字可作为同组；图表为原生整体组。 |
| 18 | Slide Role Preset | hero、data、explanation、comparison、breath、summary 等结合 `type`/`designDNA` 控制强度；不对装饰、页脚、页码做默认动画。 |
| 19 | Morph | **没有真正写入 PPTX**。合资格候选也回退 fade，并在 schema 保存 `requestedEffect=morph` 与原因。 |
| 20 | persistentElementId | 有严格的同对象候选匹配检查，避免仅因文字相同误判，但未实现原生跨页插值。 |
| 21 | python-pptx | 现用的 `python-pptx` 没有满足此项目需求的完整高层动画 API；布局仍用它生成。 |
| 22 | Open XML 后处理 | 是。只对生成中的页以 XML 元素构建器结构化插入 `p:transition`/`p:timing`，不用字符串替换。 |
| 23 | PowerPointMotionRenderer | 独立模块完成语义目标→shape ID 绑定、trigger 时间树和具体效果 XML；每页异常可回退无动画并记录 warning，避免整份损坏。 |
| 24 | Preview Motion Renderer | `presentationMotion.ts` 通过 Web Animations API 执行 cue；有重播、点击推进、切页清理、卸载清理及 reduced-motion 静态终态。 |
| 25 | 共享 Schema | PPTX 与网页消费同一份 `presentation.json` cue；Web 不重新规划顺序/时长。网页 DOM 布局不是 Office 像素级复刻，UI 明示这是动画模拟。 |
| 26 | Capability Matrix | 代码 `CAPABILITIES` 按已实现效果标注。原生 Morph=false、Web=交叉淡化近似；图表 series=false，回退整图 wipe。 |
| 27 | Fallback | Morph→fade；非文字颜色强调→pulse；不安全/过多效果→限幅或静态；XML 写入出错仅该页无动画，保留 PPTX。 |
| 28 | Motion QA | 检查无效目标、重复顺序、组数、时长/延迟/时间轴、效果/方向过多、无效 persistent ID、Morph、层级倒置、allFade 与连续重复。输出 `visualQA.motionQA`。 |
| 29 | Auto Fix | 确定性裁剪预算、约束时长与距离、限制效果家族和方向、Morph 降级、连续三页同模板做有限语义变奏；显式用户排序保留并只提示层级偏差。 |
| 30 | Anti-AI Rules | 避免整页统一淡入、所有项目同 delay、过多 Fly/Zoom、多方向与随机转场；检测系统有启发式限制，不能客观证明“像人类设计”。 |
| 31 | 自然语言修改 | Agent 提示词规定基于最新 `presentation.json` 编辑受影响字段、重规划 affected timeline，再经同一编排和 QA。真实模型对列举的每句指令的遵从率**未验证**。 |
| 32 | Snapshot 隔离 | 单元测试确认二次修改生成新 artifact/project/snapshot ID、旧二进制保持不变；Worker 浏览器验收确认两份 PPT 切换 Code 不串源码、React/Three 源码各自独立。 |

## 实机与回归（对应需求 33–45）

| # | 项目 | 实测结果 / 边界 |
| --- | --- | --- |
| 33 | PowerPoint 实机 | 本机 PowerPoint COM 打开并**实际逐页放映** effects 10/10、launch 10/10、consulting 12/12、launch-click 10/10。主时间轴分别读取 10/33/34/35 个效果；诊断版确认 10 种效果及 fade/push/wipe 原生转场，未见文件修复提示。COM 逐页导航并读取已到达的页码；尚未逐帧录像判定每个动画的审美。静态导出 PNG 已人工查看封面、卡片、咨询页，文字与图片区保持可见。 |
| 34 | WPS | **未验证**；不以 PowerPoint 结果替代。 |
| 35 | Preview Worker | 独立开发验收页加载 2 个不同内容 PPT 加 1 个同名新 ID，Code 分别显示匹配的 `presentation.json`；软隐藏 3D 快照后列表消失，从该项目按钮恢复。现有核心测试覆盖快照还原、去重、清空/恢复等。真实用户会话跨设备刷新**未作 UI 验证**。 |
| 36 | React | 浏览器中真实构建 `React isolation fixture.html` 成功，沙箱 iframe 显示该标题；Code 打开对应 `App.tsx`，没有 PPT/3D 代码。核心测试另覆盖 esbuild 的 React JSX 编译。 |
| 37 | Three.js | 浏览器中真实场景快照构建成功，Code 显示对应 `scene.json`；GLB 导出路径、SceneSpec 验证与混合虚拟项目有自动化测试。实际视觉旋转与本轮下载落盘**未验证**。 |
| 38 | Office/PDF | 后端回归测试生成 Word/Excel/PPT/PDF 样本，验证预览文本与各自下载响应、PDF inline；动画 shape group 的文字也能被旧版 PPT 文本预览读取。完整 Worker 中逐一点击真实 Office/PDF 文件**未验证**。 |
| 39 | Server Tests | `PREVIEW_TEST_URL=http://127.0.0.1:5173` 时 `venv/Scripts/python.exe -m unittest discover -s tests -v`：**54/54 通过，无跳过**。未设该变量时同为 54 项、其中 1 项跳过。 |
| 40 | TypeScript | `npx tsc --noEmit` 通过；后续继续按同一项目脚本复核。 |
| 41 | Web Preview Tests | `npm run test:preview` 对应 42/42 通过，含 React/Three、PPT A/B 同名 ID、播放器时钟/取消和减弱动态效果。 |
| 42 | Web Build | `npm run build` 通过；现有大于 500KB 的 chunk 警告保留，并非构建失败。 |
| 43 | 测试文件 | `.runlogs/motion-acceptance/launch.pptx`、`consulting.pptx`、`launch-click.pptx`、`effects.pptx`；同目录有 `powerpoint-playback.json`、PNG 和 `manifest.json`。PPTX 夹具数据为概念示意，不是商业产品事实。 |
| 44 | project.md | 记录共享 schema、角色编排、token、预算/分组、原生与网页映射、QA/降级、图片缓存、实际验收及未验证能力；删除过时的“只支持零星点击淡入”现状描述。 |
| 45 | 未实现 | 原生 Morph/复杂 motion path/原生图表 series 逐步播放/音频 BGM/视觉等价的逐帧 Office-Web 渲染；WPS、真实用户会话跨设备 UI 和系统“另存为”最终落盘未验证。 |

## 已知质量边界

- `launch` 实测仅 1/10 页有 Pexels 图、`consulting` 仅 1/12 页有图；其余页使用主题兜底，不应声称每页自动补图。点击版在缓存状态下有 3/10 页配图；跨进程或超过缓存 TTL 不保证图像分配相同。这是图片可用性与缓存边界，不是 Motion timeline 缺失。
- 浏览器点击下载会调用系统保存选择器，自动化未取得落盘结果，因此只确认文件路由、下载标签与后端响应；不虚报浏览器实际保存成功。
- 动画的目标是克制、按信息层级组织；是否达到特定品牌设计水准属于主观设计评审，尚不能由测试自动证明。
