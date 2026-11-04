"""
Prompt templates for all LLM interactions.

可配置模式：内置默认值写在本文件 _DEFAULTS 中；仓库根目录 prompts/ 下
每个 prompt 一个同名 .txt 文件（如 GENERATE_TITLE.txt），文件内容即为该
提示词全文（原始文本，无需转义），存在则覆盖默认值，文件缺失/为空回退
内置默认。修改后重启后端生效。目录路径可用环境变量 PROMPTS_DIR 覆盖。

模板使用 Python .format() 风格占位符：{variable_name}；字面花括号需写双括号。
"""

import logging
from pathlib import Path

from app.config import PROMPTS_DIR

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════
#  内置默认 Prompt（配置文件缺失/键未提供时回退到这里）
# ═══════════════════════════════════════════════════════════════

_DEFAULTS: dict[str, str] = {
    # ── Tag & Entity Extraction (llm_extract.py) ──
    "EXTRACT_TAGS_ENTITIES": """从以下文档内容中提取关键概念和实体。

标签（tags）：提取专业词汇和具体社会事件。
- 术语：特定专业领域的概念（如“网络安全等级保护”、“生成式人工智能”）
- 事件：有明确名称的社会事件（如"唐山烧烤摊打人事件"、"2026肖战南京演唱会"）

实体（entities）：只提取具有唯一、具体名称的实体，必须能在现实或虚构世界中唯一标识。
- 人物：有具体姓名的个人（如"鲁迅"、"爱因斯坦"）
- 组织：有正式名称的机构/公司/团体（如"Google"、"清华大学"）
- 地点：有具体名称的地理位置（如"北京"、"硅谷"）
- 物品：有具体名称或标识的网络账号、电话号码（如"轻舞飞扬"、"13888888888"）

不要提取泛化概念（如"机器学习"、"项目管理"、"云计算"）——这些应作为标签。
不要提取无具体标识的泛指（如"工程师"、"互联网公司"、"数据库"）。
不要提取范围很大的地址（如"中国"、"上海市"、"南京市鼓楼区"）。

关系（relations）：只提取实体之间的关系，source 和 target 必须都是已提取的实体，
并同时给出它们在 entities 列表中的类型（source_type / target_type，必须与 entities 中一致）。
实体以「名称+类型」作为唯一标识，同一名称可以有多个不同类型。
- 示例：Google 开发了 Kubernetes → {{"source":"Google","source_type":"组织","target":"Kubernetes","target_type":"产品","label":"开发"}}

以 JSON 格式返回（只返回 JSON，不要其他内容）：
{{"tags":["标签1","标签2"],"entities":[{{"name":"实体名","type":"类型"}}],"relations":[{{"source":"源实体名","source_type":"源实体类型","target":"目标实体名","target_type":"目标实体类型","label":"关系描述"}}]}}

根据内容量自动决定提取数量，全面覆盖所有符合条件的的实体和标签。

{text}""",

    # ── Image & Video Description (upload.py) ──
    "IMAGE_DESCRIPTION": (
        "请用中文详细描述这张图片的内容（不超过300字）。"
        "如果是文档截图、表格、图表，请尽可能提取其中的文字信息。"
    ),

    "VIDEO_DESCRIPTION": (
        "这是一个视频文件「{name}」，时长约 {duration:.0f} 秒。"
        "以下是从视频中提取的 {frame_count} 个关键帧画面（按时间顺序）。"
        "请用中文详细描述这个视频的内容（不超过 300 字），包括：\n"
        "1. 视频的主题和场景\n"
        "2. 出现的人物、物体或活动\n"
        "3. 画面随时间的变化\n"
        "4. 视频想要传达的信息"
    ),

    # ── Title Generation (upload.py) ──
    "GENERATE_TITLE": """你是一个专业的文档摘要专家。请仔细阅读以下文档内容，在**理解全文主旨**的基础上，用一句完整、精炼的话概括文档的核心内容，作为标题。

核心原则：
1. 先通读全文，理解文档在讲什么，然后用自己的话提炼标题
2. 标题应该概括文档的整体主题，而不是照抄文中的某一句
3. 让读者一眼就能知道这份文档是关于什么的

具体要求：
- 15-40 个字，简洁完整
- 技术文档 → 概括技术主题和要点
- 聊天记录/对话 → 概括讨论的主要话题和结论
- 图片描述 → 概括图片的主要内容和场景
- 音视频内容 → 概括主题和关键信息
- 不要包含"标题：""本文""该文档"等冗余词语
- 不要使用引号、书名号或 Markdown 格式
- 只输出标题文本本身，不要任何解释

好的标题示例：
- Python 异步编程的核心概念与最佳实践
- 2025 年产品路线图与关键里程碑规划
- 基于深度学习的图像目录模型优化方法
- 团队关于微服务架构迁移的技术方案讨论
- 城市夜景航拍照片，展示 CBD 核心区的灯光与建筑群

差的标题（避免）：
- 在本文中我们将讨论异步编程  ← 冗余前缀
- 第一章 概述  ← 没有实际信息
- 接下来我们来看一下  ← 口语化，无概括

---
文档内容：

{context}

---
请为以上文档生成标题（只输出标题本身）：""",

    # ── Video Description — short version for QA context (qa.py) ──
    "QA_VIDEO_DESCRIPTION": (
        "视频「{name}」，{frame_count} 个关键帧，时长约 {duration:.0f} 秒。"
        "请用中文简要描述视频内容（100-200 字）。"
    ),

    # ── Q&A System Prompts (qa.py) ──
    "QA_WITH_KB_INTRO": "你是一个知识库问答助手。",

    "QA_WITH_KB_INSTRUCTIONS": (
        "请根据以下知识库文章的内容回答用户的问题。\n"
        "如果知识库中有'实体附加信息'部分，请优先参考。"
    ),

    "QA_WITH_KB_IMAGES": "用户上传了图片，请基于图片内容回答问题。",

    "QA_WITH_KB_FALLBACK": "如果信息不足以完整回答，可以结合你的通用知识补充。",

    "QA_CLOSING": "回答要简洁、准确，使用中文。",

    "QA_NO_KB": (
        "你是一个知识库问答助手。当前知识库中没有与问题直接相关的内容。"
        "请利用你的通用知识回答用户的问题。\n"
        "回答要简洁、准确，使用中文。"
    ),
}


# ═══════════════════════════════════════════════════════════════
#  配置覆盖加载
# ═══════════════════════════════════════════════════════════════

def _load_overrides() -> dict[str, str]:
    """读取 prompts/ 目录下各同名 .txt 覆盖项；文件缺失/为空时回退内置默认。"""
    overrides: dict[str, str] = {}
    dir_path = Path(PROMPTS_DIR)
    for name in _DEFAULTS:
        file_path = dir_path / f"{name}.txt"
        try:
            content = file_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except OSError as e:
            logger.warning("prompts 覆盖文件读取失败 %s: %s", file_path, e)
            continue
        if not content.strip():
            logger.warning("prompts 覆盖文件为空，回退内置默认: %s", file_path)
            continue
        overrides[name] = content.rstrip()  # 去掉文件末尾换行，保留正文原样
    return overrides


_OVERRIDES = _load_overrides()


def _get(name: str) -> str:
    return _OVERRIDES.get(name) or _DEFAULTS[name]


# ═══════════════════════════════════════════════════════════════
#  模块级导出（外部 `from app.prompts import XXX` 用法不变）
# ═══════════════════════════════════════════════════════════════

EXTRACT_TAGS_ENTITIES = _get("EXTRACT_TAGS_ENTITIES")
IMAGE_DESCRIPTION = _get("IMAGE_DESCRIPTION")
VIDEO_DESCRIPTION = _get("VIDEO_DESCRIPTION")
GENERATE_TITLE = _get("GENERATE_TITLE")
QA_VIDEO_DESCRIPTION = _get("QA_VIDEO_DESCRIPTION")
QA_WITH_KB_INTRO = _get("QA_WITH_KB_INTRO")
QA_WITH_KB_INSTRUCTIONS = _get("QA_WITH_KB_INSTRUCTIONS")
QA_WITH_KB_IMAGES = _get("QA_WITH_KB_IMAGES")
QA_WITH_KB_FALLBACK = _get("QA_WITH_KB_FALLBACK")
QA_CLOSING = _get("QA_CLOSING")
QA_NO_KB = _get("QA_NO_KB")
