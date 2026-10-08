"""Lightweight web-skill eligibility, not another tool executor or LLM router."""

import re


def _has(pattern: str, text: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE) is not None


def web_search_declined(text: str) -> bool:
    return _has(
        r"(?:不要|不用|别|禁止|不需要|不必|无需|先不|暂不).{0,6}(?:联网|上网|搜索|检索)|"
        r"(?:不联网|离线回答|仅凭(?:已有|现有|你的)知识|只根据(?:我提供|下面|以下|这段))|"
        r"(?:do not|don't|no)\s+(?:browse|search)|(?:without|offline)\s+(?:browsing|search)", text,
    )


def local_or_private_subject(text: str, *, include_source_names: bool = True) -> bool:
    # A public-search fallback must not send workspace paths or private source
    # to an external provider simply because the route was inconclusive. A
    # bare "repository"/"仓库" is not private: public GitHub repositories are
    # a primary target of the code-search capability.
    return _has(
        r"(?:本地|磁盘|工作区|后台|服务端|当前项目|我的项目|这个项目|该项目|本项目|预览项目|Gor源码)|"
        r"(?:当前|我的|本轮).{0,8}(?:源码|代码|文件|页面|会话|session|工作区)|"
        r"(?:本地|私有|内部|公司内部).{0,8}(?:仓库|代码库|源码|代码)|"
        r"(?:这个).{0,8}(?:工作区|本地项目|私有仓库|项目文件|会话)|"
        r"(?:知识库|私有资料|内部文档|我上传|上传的(?:文件|资料|文档))|"
        r"(?:[a-z]:[\\/]|file://|sessionId|workspaceId)|```", text,
    ) or (include_source_names and _has(
        r"(?<![\w.-])[\w./\\-]+\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b", text,
    ))


def fresh_public_information(text: str) -> bool:
    return _has(
        r"(?:最近|近期|近来|这几天|这几个月|今年|今天|现在|目前).{0,24}"
        r"(?:发布|推出|上线|模型|版本|新闻|消息|进展|变化|动态|政策|价格|现任)|"
        r"(?:最新|目前|当前|现行|现在|最新版|最新的).{0,18}(?:版本|型号|release|version|edition)|"
        r"(?:版本|型号|release|version|edition).{0,18}(?:最新|目前|当前|现行|现在|最新版)|"
        r"(?:发布|推出|上线|上市|更新|升级).{0,18}(?:新|模型|版本|产品)|"
        r"(?:新模型|新版本|新版|新产品|新政策|新动态|有什么新|有啥新)|"
        r"(?:Grok|xAI|OpenAI|Claude|Gemini|DeepSeek).{0,12}(?:发布了|推出了|上线了|更新了|升级了)|"
        r"(?:latest|recent|new|current).{0,30}(?:model|release|version|update|news|price)|"
        r"(?:released|launched|announced).{0,24}(?:model|version|product)", text,
    )


def news_search_intent(text: str) -> bool:
    return _has(
        r"(?:新闻|时事|热点|突发|资讯|新闻稿|媒体报道|重要消息|报道|news|breaking)|"
        r"(?:最新|目前|当前|现行|现在|最新版).{0,18}(?:版本|型号|release|version|model)|"
        r"(?:版本|型号|release|version|model).{0,18}(?:最新|目前|当前|现行|现在|最新版)|"
        r"(?:(?:最近|近期|最新|今年|今天|现在|目前).{0,16}(?:发布|推出|上线|更新|模型|产品|政策|动态|消息|新闻|进展)|"
        r"(?:发布|推出|上线|更新).{0,12}(?:什么新|哪些新|新模型|新版本|模型|产品|政策)|"
        r"(?:新模型|新版本|有什么新|有啥新)|"
        r"(?:latest|recent|new|current).{0,20}(?:news|model|release|version|edition|launch|announcement|policy|update))",
        text,
    )


def github_code_search_intent(text: str) -> bool:
    explicit_repository = _has(
        r"(?:github|gitlab|仓库|repo(?:sitory)?|repository|issue|\bPR\b|开源项目|开源实现|open[- ]source|"
        r"参考项目|示例源码|真实实现)",
        text,
    )
    source_research = _has(
        r"(?:搜索|搜一下|找几个|找一些|找下|查找|参考|看看|有哪些|分析|研究|对比|find|search|look\s+up|"
        r"show\s+me|compare|analy[sz]e|research)", text,
    ) and _has(
        r"(?:代码|源码|源代码|实现|示例|项目|仓库|开源|issue|\bPR\b|\bcode\b|source\s+code|"
        r"implementation|example|repository|open[- ]source)", text
    )
    return explicit_repository or source_research


def public_web_followup(text: str, history: list[dict] | None) -> bool:
    """Only a short topical follow-up may inherit recent public user context."""
    if len(text) > 80 or not _has(r"(?:那|它|这个|现在|最近|最新|呢|怎样|怎么样|还有|进展)", text):
        return False
    for message in reversed((history or [])[-8:]):
        if message.get("role") != "user":
            continue
        previous = str(message.get("content", ""))[:1000]
        if local_or_private_subject(previous) or web_search_declined(previous):
            return False
        return fresh_public_information(previous) or _has(r"(?:新闻|最新|联网|搜索|查一下|现任|价格)", previous)
    return False


def clear_direct_answer(text: str) -> bool:
    """Clearly conversational/transformational turns need no web schema."""
    value = text.strip()
    if not value:
        return True
    if re.fullmatch(
        r"(?:(?:你好|您好|嗨|hello|hi|早上好|晚上好)[，,\s]*)?"
        r"(?:谢谢(?:你)?|好的?|可以|行|嗯|对|没问题|(?:现在)?继续|再见|取消|停止|今天怎么样|你好吗)?[。！!？?\s]*",
        value, re.IGNORECASE,
    ):
        return True
    if _has(r"(?:讲|说|写).{0,8}(?:笑话|故事|诗|童话)|^(?:翻译|润色|改写)|"
            r"^(?:总结|概括|整理|提取).{0,8}(?:以下|下面|这段|给定)|"
            r"(?:怎么|如何).{0,12}(?:把|将).{0,12}(?:标题|按钮|页面).{0,12}(?:改|换)", value):
        return True
    if re.fullmatch(r"(?:计算|算一下|帮我算)?\s*[\d\s.+*/()×÷=％%\-]+(?:是多少|等于多少)?[？?。]*", value):
        return True
    return _has(r"(?:revision|递归|闭包|冒泡排序|勾股定理|二进制|变量|函数|HTTP|JSX|useState)\s*(?:是什么|什么意思|的定义)|"
                r"什么是\s*(?:revision|递归|闭包|冒泡排序|勾股定理|二进制|变量|函数|HTTP|JSX|useState)", value)
