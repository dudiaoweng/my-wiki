"""Shared LLM extraction — tags + entities + relations from document text.

Used by both upload (async → via asyncio.to_thread) and articles CRUD (sync).
"""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

_EXTRACT_PROMPT = (
    "从以下文档内容中提取关键概念和实体。\n"
    "- 概念类（概念、技术、工具、方法、标准、语言）→ 作为标签\n"
    "- 实体类（人物、组织、地点、事件、产品）→ 作为实体，含关系\n"
    "以 JSON 格式返回（只返回 JSON，不要其他内容）：\n"
    '{{"tags":["标签1","标签2"],"entities":[{{"name":"实体名","type":"类型"}}],"relations":[{{"source":"源实体","target":"目标实体","label":"关系描述"}}]}}\n'
    "根据内容量自动决定提取数量，尽可能全面覆盖所有关键概念和实体。\n\n"
    "{text}"
)


def extract_tags_and_entities(text: str, max_chars: int = 2000) -> tuple[list[str], dict | None]:
    """Call LLM to extract tags + entities + relations from text.

    Returns (tags_list, entities_dict_or_none).
    Uses synchronous httpx with 60s timeout, 2 retries, and JSON fallback parsing.
    Returns empty results on any failure (best-effort).
    """
    if not LLM_API_KEY:
        logger.info("LLM extraction skipped: no LLM_API_KEY configured")
        return [], None

    import httpx

    prompt = _EXTRACT_PROMPT.format(text=text[:max_chars])

    last_error = None
    for attempt in (1, 2):
        try:
            with httpx.Client(timeout=120.0) as client:
                resp = client.post(
                    f"{LLM_API_BASE.rstrip('/')}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {LLM_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": LLM_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": 4000,
                        "temperature": 0.2,
                    },
                )
                resp.raise_for_status()
            break  # success
        except Exception as e:
            last_error = e
            if attempt == 2:
                logger.warning("LLM extraction failed after retries: %s", e)
                return [], None

    raw_response = resp.json()["choices"][0]["message"]["content"].strip()

    # Strip markdown code fences
    cleaned = re.sub(r'^```(?:json)?\s*\n?', '', raw_response)
    cleaned = re.sub(r'\n?```\s*$', '', cleaned).strip()

    # Parse JSON
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        # Fallback: regex-extract the JSON object
        m = re.search(r'\{[^{}]*"tags"\s*:\s*\[.*?\][^{}]*\}', cleaned, re.DOTALL)
        if m:
            try:
                result = json.loads(m.group())
            except json.JSONDecodeError:
                logger.warning("LLM JSON fallback parse failed, raw: %s", raw_response[:200])
                return [], None
        else:
            logger.warning("LLM returned non-JSON: %s", raw_response[:200])
            return [], None

    if not isinstance(result, dict):
        logger.info("LLM returned non-dict")
        return [], None

    # Extract tags
    raw_tags = result.get("tags", [])
    tags: list[str] = []
    if isinstance(raw_tags, list):
        tags = [t.strip() for t in raw_tags if isinstance(t, str) and t.strip()]

    # Extract entities + relations
    entities_part = result.get("entities", [])
    relations_part = result.get("relations", [])
    entities: dict | None = None
    if isinstance(entities_part, list) and entities_part:
        entities = {
            "entities": entities_part,
            "relations": relations_part if isinstance(relations_part, list) else [],
        }

    if tags or entities:
        logger.info(
            "LLM extraction success: %d tags, %d entities",
            len(tags), len(entities.get("entities", [])) if entities else 0,
        )
    else:
        logger.info("LLM extraction returned empty result")

    return tags, entities
