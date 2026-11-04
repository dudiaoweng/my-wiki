# Prompt 配置

每个提示词一个 .txt 文件，文件名对应 prompts.py 内置默认的 prompt 名称，
文件内容即为该提示词全文（原始文本，换行无需转义）。

- 删除文件或文件为空 → 回退内置默认值
- 修改后重启后端生效（Docker 部署：本目录已挂载到容器 /app/prompts，
  修改后 `docker compose restart my-wiki` 即生效）
- 占位符使用 Python .format() 风格：{text}、{context} 等；字面花括号写双括号

文件清单：

| 文件 | 用途 |
| --- | --- |
| EXTRACT_TAGS_ENTITIES.txt | 标签/实体/关系提取（llm_extract.py） |
| IMAGE_DESCRIPTION.txt | 图片描述（upload.py） |
| VIDEO_DESCRIPTION.txt | 视频描述（upload.py） |
| GENERATE_TITLE.txt | 标题生成（upload.py） |
| QA_VIDEO_DESCRIPTION.txt | 问答上下文中视频简述（qa.py） |
| QA_WITH_KB_INTRO.txt | 问答开场白（有知识库） |
| QA_WITH_KB_INSTRUCTIONS.txt | 问答指令（引用知识库文章） |
| QA_WITH_KB_IMAGES.txt | 问答附带图片说明 |
| QA_WITH_KB_FALLBACK.txt | 知识库不足时的补充说明 |
| QA_CLOSING.txt | 问答收尾要求 |
| QA_NO_KB.txt | 无知识库内容时的系统提示词 |
