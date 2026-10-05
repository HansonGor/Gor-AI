"""Deterministic schema fixtures for the three human-like design acceptance briefs."""

from __future__ import annotations


def acceptance_designs():
    ev = {
        "title": "新能源汽车行业判断",
        "audience": "投资人",
        "purpose": "用事实与结构梳理行业投资判断",
        "theme": "modern-light",
        "artDirection": {"mood": ["premium", "restrained"], "visualLanguage": "editorial investment brief", "densityDirection": "alternate evidence-rich analysis with quiet thesis pages"},
        "designDNA": {"compositionStyle": "editorial", "whitespace": "generous", "alignment": "asymmetric", "typographyScale": "oversized", "decorationLevel": "minimal"},
        "slides": [
            {"id": "ev-cover", "type": "cover", "title": "新能源汽车行业判断", "keyMessage": "增长没有消失，只是在换挡。", "slideRole": "hero", "visualIntensity": 5},
            {"id": "ev-thesis", "type": "title-content", "title": "规模之外，结构正在重排", "keyMessage": "判断行业，不再只看总销量。", "slideRole": "breath", "visualIntensity": 1},
            {"id": "ev-market", "type": "big-number", "title": "增长仍在，但分化扩大", "keyMessage": "把增长和盈利能力分开看。", "metrics": [{"label": "样例指标（非行业事实）", "value": "—", "note": "以已核验的来源数据替换"}], "sources": ["待补充经核验来源"], "slideRole": "data", "visualIntensity": 5},
            {"id": "ev-chart", "type": "chart", "title": "增长曲线要看拐点", "chart": {"type": "line", "title": "示意数据，生成验收用", "categories": ["阶段一", "阶段二", "阶段三", "阶段四"], "series": [{"name": "示意趋势", "values": [2, 3, 3.5, 5]}], "chartInsight": "增速的变化比单点规模更值得关注", "highlightPoint": "阶段四", "annotation": "示意数据，不作为市场结论"}, "slideRole": "data", "visualIntensity": 4},
            {"id": "ev-editorial", "type": "image-text", "title": "产品体验决定溢价能否留下", "keyMessage": "从参数优势走向真实使用价值。", "supportingPoints": ["软件体验", "补能便利", "售后服务"], "imageQuery": "premium electric vehicle interior detail, natural side light, editorial photography", "slideRole": "explanation", "visualIntensity": 3},
            {"id": "ev-compare", "type": "comparison", "title": "竞争焦点正从价格迁移到体验", "supportingPoints": ["价格与规模：短期更易观察", "体验与服务：决定长期留存"], "slideRole": "comparison", "visualIntensity": 4},
            {"id": "ev-risk", "type": "table", "title": "收益判断必须同步审视风险", "table": {"headers": ["观察项", "验证问题"], "rows": [["价格", "降价后毛利是否稳定？"], ["供应链", "关键环节是否可替代？"], ["渠道", "库存与交付是否匹配？"]]}, "slideRole": "evidence", "visualIntensity": 3},
            {"id": "ev-evidence", "type": "metrics", "title": "投资判断需要三组证据", "metrics": [{"label": "销量质量", "value": "待核验"}, {"label": "单位经济", "value": "待核验"}, {"label": "现金效率", "value": "待核验"}], "slideRole": "data", "visualIntensity": 4},
            {"id": "ev-quote", "type": "quote", "title": "核心判断", "quote": "好产品不是参数的总和，而是用户愿意持续选择的理由。", "attribution": "投资判断框架", "slideRole": "emotional", "visualIntensity": 2},
            {"id": "ev-close", "type": "summary", "title": "把注意力放在结构性赢家", "keyMessage": "验证产品力、单位经济与现金流，再讨论规模。", "supportingPoints": ["用可核验数据替代行业口号", "区分短期竞争与长期壁垒"], "slideRole": "summary", "visualIntensity": 3},
        ],
    }
    phone = {
        "title": "AI 手机产品发布",
        "audience": "发布会观众",
        "purpose": "用少字、大画面和重点数字呈现产品体验",
        "theme": "technology",
        "artDirection": {"mood": ["cinematic", "confident"], "visualLanguage": "launch keynote with product-led imagery", "densityDirection": "few words, strong visual pauses"},
        "designDNA": {"compositionStyle": "dramatic", "whitespace": "dramatic", "typographyScale": "oversized", "contrast": "high", "decorationLevel": "minimal", "imageTreatment": "cinematic"},
        "slides": [
            {"id": "phone-cover", "type": "cover", "title": "让 AI 成为日常直觉", "subtitle": "新一代 AI 手机", "slideRole": "hero", "visualIntensity": 5},
            {"id": "phone-thesis", "type": "title-content", "title": "少一步操作，多一点理解", "keyMessage": "AI 不该增加流程，而应减少打断。", "slideRole": "statement", "visualIntensity": 2},
            {"id": "phone-product", "type": "image-text", "title": "从一句话开始完成复杂任务", "supportingPoints": ["跨应用理解上下文", "按需组织信息", "重要操作交由用户确认"], "imageRole": "product", "imageQuery": "sleek AI smartphone on dark sculptural pedestal, dramatic studio side light, premium product editorial photography", "slideRole": "hero", "visualIntensity": 5},
            {"id": "phone-number", "type": "big-number", "title": "响应更快，操作更短", "metrics": [{"label": "演示指标（待产品实测）", "value": "—", "note": "不预置或虚构性能数据"}], "slideRole": "data", "visualIntensity": 4},
            {"id": "phone-demo", "type": "image-text", "title": "把零散信息整理成下一步", "supportingPoints": ["识别用户意图", "汇总相关内容", "确认后执行动作"], "imageRole": "product", "imageQuery": "close-up smartphone assistant interface in use, warm modern home, natural window light, editorial product photography", "slideRole": "explanation", "visualIntensity": 3},
            {"id": "phone-compare", "type": "comparison", "title": "更少切换，更完整的任务流", "supportingPoints": ["传统：在应用之间查找与复制", "AI 协同：围绕目标组织步骤"], "slideRole": "comparison", "visualIntensity": 4},
            {"id": "phone-quote", "type": "quote", "title": "发布会主张", "quote": "真正聪明的技术，让复杂留在系统里。", "attribution": "产品体验原则", "slideRole": "emotional", "visualIntensity": 2},
            {"id": "phone-close", "type": "summary", "title": "AI，回到你手中", "keyMessage": "更自然地理解，更克制地行动。", "slideRole": "summary", "visualIntensity": 5},
        ],
    }
    consulting = {
        "title": "企业 AI 转型路线图",
        "audience": "管理层",
        "purpose": "以治理、价值和实施路径形成决策框架",
        "theme": "business",
        "artDirection": {"mood": ["clear", "evidence-led"], "visualLanguage": "consulting editorial with structured evidence", "densityDirection": "dense evidence punctuated by decision pages"},
        "designDNA": {"compositionStyle": "consulting", "density": "high", "whitespace": "balanced", "typographyScale": "restrained", "chartStyle": "analytical", "decorationLevel": "minimal"},
        "slides": [
            {"id": "ai-cover", "type": "cover", "title": "企业 AI 转型路线图", "keyMessage": "从试点热度转向可量化的经营价值。", "slideRole": "hero", "visualIntensity": 4},
            {"id": "ai-summary", "type": "summary", "title": "转型成败取决于价值闭环", "supportingPoints": ["业务问题优先于模型选择", "流程重构决定规模化收益", "治理与风险控制需要前置"], "slideRole": "summary", "visualIntensity": 3},
            {"id": "ai-chart", "type": "chart", "title": "先定义要改善的运营指标", "chart": {"type": "bar", "categories": ["质量", "时效", "成本", "体验"], "series": [{"name": "目标方向（示意）", "values": [4, 3, 5, 2]}], "chartInsight": "选择能映射到经营结果的指标", "annotation": "示意评分，不代表企业实测"}, "slideRole": "data", "visualIntensity": 4},
            {"id": "ai-compare", "type": "comparison", "title": "从孤立试点转向端到端流程", "supportingPoints": ["试点：单点自动化、局部提效", "规模化：流程重构、责任可追踪"], "slideRole": "comparison", "visualIntensity": 4},
            {"id": "ai-process", "type": "process", "title": "按风险分层推进落地", "timeline": [{"label": "01", "title": "识别场景", "detail": "基于价值、可行性和风险排序"}, {"label": "02", "title": "验证闭环", "detail": "定义指标、样本和人工兜底"}, {"label": "03", "title": "纳入流程", "detail": "明确数据权限与业务责任"}, {"label": "04", "title": "持续治理", "detail": "监测质量、成本与风险"}], "slideRole": "explanation", "visualIntensity": 3},
            {"id": "ai-table", "type": "table", "title": "治理边界必须可以执行", "table": {"headers": ["控制点", "管理要求", "责任方"], "rows": [["数据", "最小权限与留痕", "数据负责人"], ["模型", "评估与版本管理", "技术负责人"], ["流程", "人工复核与升级", "业务负责人"]]}, "slideRole": "evidence", "visualIntensity": 4},
            {"id": "ai-metric", "type": "big-number", "title": "先衡量价值，再扩大投入", "metrics": [{"label": "价值基线", "value": "先定义", "note": "无基线就无法验证改进"}], "slideRole": "statement", "visualIntensity": 5},
            {"id": "ai-metrics", "type": "metrics", "title": "组合评估收益与风险", "metrics": [{"label": "业务价值", "value": "收益"}, {"label": "落地成本", "value": "投入"}, {"label": "风险暴露", "value": "控制"}, {"label": "采用程度", "value": "持续"}], "slideRole": "data", "visualIntensity": 3},
            {"id": "ai-quote", "type": "quote", "title": "转型原则", "quote": "先把工作设计好，再决定哪些步骤交给 AI。", "attribution": "实施原则", "slideRole": "emotional", "visualIntensity": 1},
            {"id": "ai-org", "type": "title-content", "title": "运营机制比一次性项目更重要", "supportingPoints": ["设立业务、数据、技术共同负责机制", "把质量监控纳入日常运营", "保留人工接管与回滚路径"], "slideRole": "explanation", "visualIntensity": 3},
            {"id": "ai-risk", "type": "chart", "title": "风险控制要匹配应用影响面", "chart": {"type": "line", "categories": ["低影响", "中影响", "高影响"], "series": [{"name": "复核要求（示意）", "values": [1, 3, 5]}], "chartInsight": "影响越高，评测和人工复核越严格", "annotation": "治理示意，不是法规分级"}, "slideRole": "data", "visualIntensity": 4},
            {"id": "ai-close", "type": "summary", "title": "以可验证的经营结果扩展 AI", "keyMessage": "小步验证，进入流程，持续治理。", "slideRole": "summary", "visualIntensity": 2},
        ],
    }
    return {"ev-investor": ev, "ai-phone-launch": phone, "enterprise-ai-consulting": consulting}
