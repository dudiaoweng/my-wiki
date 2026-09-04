"""Shared LLM extraction — tags + entities + relations from document text.

Used by both upload (async → via asyncio.to_thread) and articles CRUD (sync).
"""

import asyncio
import json
import logging
import re

from app.config import LLM_API_KEY, LLM_API_BASE, LLM_MODEL
from app.prompts import EXTRACT_TAGS_ENTITIES

logger = logging.getLogger(__name__)


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

    prompt = EXTRACT_TAGS_ENTITIES.format(text=text[:max_chars])

    last_error = None
    raw_response = None
    for attempt in range(3):  # 3 attempts = 2 retries
        try:
            with httpx.Client(timeout=60.0) as client:
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
                data = resp.json()
            # Extract content safely — guards against a 200 response with an
            # error body / unexpected shape, which would otherwise bypass retry
            # handling and leak a raw exception to the caller.
            choices = data.get("choices") or []
            if not choices:
                raise ValueError("LLM returned no choices")
            raw_response = (choices[0].get("message") or {}).get("content", "") or ""
            raw_response = raw_response.strip()
            if not raw_response:
                raise ValueError("LLM returned empty content")
            break  # success
        except Exception as e:
            last_error = e
            if attempt == 2:  # last attempt
                logger.warning("LLM extraction failed after retries: %s", e)
                return [], None

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


async def extract_chunks_iter(segments: list[str], max_chars: int = 2000, max_segments: int = 10):
    """分段提取的异步迭代器：每段完成后立即 yield (tags, entities_dict)。

    分段列表由调用方提供（向量分块 ArticleChunk），提取与 Q&A 检索共用同一
    套切分。调用方可在每段 yield 后立即落库（逐段落库）——后续段失败时已
    保存的结果不受影响。未配置 API key 或无分段时不产出任何结果。
    """
    if not LLM_API_KEY:
        logger.info("LLM extraction skipped: no LLM_API_KEY configured")
        return
    if not segments:
        return

    if len(segments) > max_segments:
        logger.info(
            "LLM chunked extraction: %d segments, only first %d processed",
            len(segments), max_segments,
        )
        segments = segments[:max_segments]

    for seg in segments:
        tags, entities = await asyncio.to_thread(extract_tags_and_entities, seg, max_chars)
        yield tags, entities


def merge_tags(current: list[str], new_tags: list[str]) -> list[str]:
    """合并标签（按名称去重，保持顺序）。"""
    merged = list(current)
    for t in new_tags:
        if t not in merged:
            merged.append(t)
    return merged


def _rel_key(r: dict) -> tuple:
    """关系去重键 — 实体以「名称+类型」为标识，关系两端均纳入类型。"""
    return (r.get("source"), r.get("source_type") or "", r.get("target"), r.get("target_type") or "", r.get("label"))


def merge_entities(current: dict | None, incoming: dict | None) -> dict | None:
    """合并两批实体/关系（实体按 name+type、关系按 source+source_type+target+target_type+label 去重）。"""
    if not isinstance(incoming, dict):
        return current
    ents = list(current.get("entities", [])) if isinstance(current, dict) else []
    rels = list(current.get("relations", [])) if isinstance(current, dict) else []
    seen_ents = {(e.get("name"), e.get("type")) for e in ents}
    for e in incoming.get("entities", []):
        key = (e.get("name"), e.get("type"))
        if key not in seen_ents:
            seen_ents.add(key)
            ents.append(e)
    seen_rels = {_rel_key(r) for r in rels}
    for r in incoming.get("relations", []):
        key = _rel_key(r)
        if key not in seen_rels:
            seen_rels.add(key)
            rels.append(r)
    if not ents:
        return None
    return {"entities": ents, "relations": rels}
