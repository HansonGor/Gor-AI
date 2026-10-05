# PPT Design Reference System 实施报告

本阶段实现的是**按用途加权的设计参考档案**，不是模板抓取或 PPT 自动套版。八个网站被建模为各有所长的元数据来源，输出可解释的参考方案，再把抽象设计方向交给原有 PPT 生成流程。以下按需求中的 33 项逐项说明；此前工作区已有的 Motion、Pexels 和 Preview 改动均予保留。

## 实现与配置

1. **修改文件**：`Server/tools/presentation.py`、`Server/tools/presentation_design.py`、`Server/tools/presentation_renderer.py`、`Server/agent/prompts.py`、`Web/src/types.ts`、`Web/src/components/preview/PresentationPreview.tsx`、`project.md`。封面标题栏的离线无图宽度也在 renderer 中修正。
2. **新增文件**：`Server/tools/presentation_reference.py`、`Server/tests/test_presentation_reference.py`、`Server/tests/generate_reference_acceptance.py`、本报告。验收样片在被 Git 忽略的 `.runlogs/reference-acceptance/`。
3. **Reference Source 数据结构**：`PresentationReferenceSource` 记录 ID、名称、官方链接、基础权重、强弱项、适用领域、语言亲和度、场景/风格/行业/受众/格式亲和度、专长领域、抽象设计特征和参考意图；Pydantic 禁止额外字段。
4. **八站配置**：Pitch 偏融资与商业叙事；Envato 偏高质感构图、产品/品牌发布；Canva 偏色彩与创意变化；Slidesgo 偏页型和信息图；SlidesCarnival 偏通用结构；Microsoft 偏原生 PowerPoint 商务/报告结构；OfficePLUS 偏中文商务与机关汇报排版；优品PPT 偏中文工作总结和信息密度。它们都是人工编码的**抽象档案**，不是抓取结果。
5. **Base Weight**：Pitch `0.95`，Envato `0.93`，Canva `0.88`，Slidesgo `0.82`，SlidesCarnival `0.75`，Microsoft `0.75`，OfficePLUS `0.72`，优品PPT `0.62`。基础权重不是最终排名。
6. **Dynamic Weight 算法**：`raw = base × scenario × style × language × industry × audience × format`；各因子由预设亲和度映射到有下限的 `[0,1]`，防止单一不匹配将来源归零；`finalWeight = raw / max(raw)`，保留四位小数。确定性排序以原始分降序、ID 处理并列，不依赖随机数或外部站点在线状态。
7. **Scenario Relevance**：从主题/用途/受众优先判断融资、产品/品牌发布、年报、工作汇报、战略等；仅在主描述不足时参考页标题。相同来源在不同场景得分不同。
8. **Language Relevance**：中文内容提高中文档案的语言因子，国际来源仍可被选为主视觉方向；英文内容反之。不是“中文就只用中文模板”。
9. **Style Relevance**：结合 Art Direction 与用途判断专业、极简、电影感、编辑式或创意方向，再匹配各来源的风格特长。
10. **Industry Relevance**：识别政府、时尚、汽车、SaaS、咨询、教育、科技等词；各来源行业亲和度独立配置。汽车发布偏 Envato/Pitch，政府汇报偏 OfficePLUS/Microsoft。
11. **Reference Plan**：`ReferencePlan` 包含 brief、八站分数及组成因子、两主两辅来源、中文校准来源、各来源参考意图、融合/应用 DNA、布局语法、Motion 方向、字体校准、可读的决策说明和 provider 状态；保存在该 PPT 的 `/presentation.json`，不借用别的项目状态。
12. **Reference Blend**：对主辅四站的每个抽象 DNA 特征按 `finalWeight × 对应设计领域专长` 投票；同票按值稳定排序。用户指定的有界语义参考再覆盖融合值。
13. **Design DNA 提取**：目前来自人工编码的站点特征，如留白、构图、图像处理、色彩对比、信息密度和节奏；**尚无网页图片视觉分析或模板特征抽取**。只填原 schema 未明确指定的字段；已有显式 DNA 不被静默改写。
14. **OfficePLUS**：可作为中文年报/工作汇报主参考；所有中文稿另标记为字体、断行、信息密度的校准来源。不提取其实际模板内容。
15. **优品PPT**：可在中文工作总结等场景参与辅助排名，并固定参与中文稿的语义校准；较低基础权重不妨碍其专长在相关场景提高最终得分。
16. **Pitch / Envato**：融资 SaaS 以 Pitch/Envato 为主；汽车和时尚发布以 Envato 及相邻国际来源为主。中文排版另校准，避免生搬英文模板字距。
17. **Art Director 消费**：系统只给未指定的 `typographyDirection`、`compositionDirection` 写入抽象提示，并补缺省 DNA；之后仍调用现有确定性修复/编排。
18. **Layout Composer 独立性**：原有页面类型、布局家族、变体和几何渲染器未被模板替换；`layoutGrammar` 仅作计划/提示，不直接复制站点页面坐标。
19. **Motion System 消费**：未显式设置 `motionLanguage` 时，场景与风格映射到 minimal/professional/cinematic/editorial/data-driven 等既有受控方向；显式 Motion 保留，原生 PPT 与 Web 仍由现有时间轴实现。
20. **Provider Interface**：`PresentationReferenceProvider` 声明 `search/get_metadata/get_preview/analyze`；默认 `MetadataOnlyReferenceProvider` 不联网、不返回模板。可替换 provider 抛错时返回静态档案状态 `provider-fallback`。
21. **当前是否真正联网获取模板**：否。不会请求八站模板、缩略图或下载链接；Pexels 图片是独立的已有资产流程，不是参考系统的模板获取。
22. **仅 Profile / Metadata 的来源**：以上全部八站。站点描述为应用中的设计档案，不构成对网站实时内容、许可证或 API 可用性的保证。
23. **Fallback**：无 provider 或 provider 失败均使用内置确定性档案；有明确图片角色却无图的既有主题兜底不变。参考系统故障不应该阻断可编辑 PPTX 生成。
24. **Copyright / License 边界**：不下载、缓存、嵌入、克隆或再分发第三方 PPT 模板及品牌元素。未来真正检索前必须单独验证站点条款、访问/缓存/二次分发授权。当前仅使用抽象构图、文字层级与节奏规律；Pexels 照片仍走独立授权/署名路径。

## 验证

25. **Tests**：新增七项 reference 测试，覆盖八站档案、A–E 场景、分数乘积/稳定性、融合与显式覆盖、自然语言修订的快照隔离、provider 失败、PPTX 中文字体与单一项目产物。
26. **`npx tsc --noEmit`**：通过。
27. **`npm run test:preview`**：42/42 通过，包含 PPT 快照、文件树去重、下载及 React/GLB 回归。
28. **`npm run build`**：通过；Vite 仍提示已有大 chunk 警告，但没有构建失败。
29. **Server Tests**：`Server/venv/Scripts/python.exe -m unittest discover -s tests -q`，在 `Server` 目录运行，61/61 通过。
30. **Preview Worker 回归**：参考系统只增加可选 schema 字段；原有产物 ID、预览条目、源码、下载与清除路径不改。前端测试/构建通过；本阶段没有在真实聊天会话里手工走完整点击/刷新流程。
31. **Snapshot 回归**：每份 PPT 保留独立 artifact/project/snapshot ID 和完整 schema；参考方案跟随该 schema，不从当前会话全局项目回读。现有 PPT 快照隔离前后端测试通过。
32. **`project.md` 更新**：新增“PPT Design Reference System”节，记录权重公式、A–E 用例、消费顺序、版权边界及当前未实现能力。
33. **尚未实现**：真实模板 API/检索、合法缩略图分析、跨站在线状态/自动档案更新、从用户上传参考 PPT 的视觉特征抽取、对站点风格的像素级还原、WPS 全量验收及真实聊天会话的端到端人工点击验收。离线样片不包含第三方图片，仅证明结构、中文字体、PowerPoint 可打开性与基础排版。后续若接入必须在授权范围内增加 provider 和测试，不能直接抓取模板。

## 五组人工样片

| 场景 | 主参考 | 中文校准 | 检查结果 |
| --- | --- | --- | --- |
| SaaS 融资 | Pitch / Envato | OfficePLUS / 优品PPT | PowerPoint 导出，修复无图封面的中文标题孤字换行 |
| 中文企业年度工作总结 | OfficePLUS / Microsoft | OfficePLUS / 优品PPT | PowerPoint 导出，表格页可读 |
| 新能源汽车发布 | Envato / Pitch | OfficePLUS / 优品PPT | PowerPoint 导出，页内留白/核心信息可读 |
| 政府工作汇报 | OfficePLUS / Microsoft | OfficePLUS / 优品PPT | PowerPoint 导出，流程页可读 |
| 时尚品牌发布 | Envato / Canva | OfficePLUS / 优品PPT | PowerPoint 导出，主题与文本可读 |

五份样片各三页，已使用本机 PowerPoint 打开并导出 PNG 人工查看。无图离线模式下页面比较简洁，不能把它宣称成真实付费模板的高级视觉效果；生产环境图片质量仍取决于既有 Pexels 素材匹配和 Art Director 的实际内容。

## 后续检索接入补充

后续版本已接入 `PublicIndexedReferenceProvider`：生成 PPT 时按内容权重选择最多六个设计来源域，并在中文场景额外检索小红书公开索引页。检索仅保存公开搜索结果的标题、摘要和 URL；最多为对应来源提供 12% 的有界排名加成。模板文件、预览图和页面几何仍不会下载、复制或自动分析。缺少搜索 API Key、无结果或 Provider 失败时，继续使用上述离线元数据档案。

这属于“公开索引页发现 + 人工编码的抽象专长档案”，不是模板级参考分析。不能声称生成结果参考了某个具体模板，除非该页面确实出现在本次 `retrievedReferences` 中；即便命中，也只能说检索到该页面元数据，不能说已查看模板文件。
