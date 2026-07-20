import json
from contextlib import asynccontextmanager
from dotenv import load_dotenv
load_dotenv()

import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.database import init_db, SessionLocal
from app.models import Category, Article
from app.routes import articles, categories, tags, entities, stats, graph, qa, upload

# ─── Default seed data ──────────────────────────────

CATEGORY_COLORS = [
    "#1E5C8A", "#7D5E3C", "#3D7B4F", "#A0524B",
    "#5B5A8C", "#C07B3A", "#4A7A8C", "#8C5260",
]

DEFAULT_CATEGORIES = [
    {"id": "cat_1", "name": "技术笔记", "color": CATEGORY_COLORS[0]},
    {"id": "cat_2", "name": "读书笔记", "color": CATEGORY_COLORS[2]},
    {"id": "cat_3", "name": "项目文档", "color": CATEGORY_COLORS[4]},
    {"id": "cat_4", "name": "想法随笔", "color": CATEGORY_COLORS[5]},
]

DEFAULT_ARTICLES = [
    {
        "id": "a1",
        "title": "JavaScript 异步编程指南",
        "content": "# JavaScript 异步编程指南\n\nJavaScript 的异步编程是现代 Web 开发的核心技能之一。\n\n## Promise\n\nPromise 是异步编程的基础抽象，它代表一个尚未完成但预期将来会完成的操作。\n\n```js\nconst fetchData = () => {\n  return new Promise((resolve, reject) => {\n    setTimeout(() => resolve('数据已加载'), 1000);\n  });\n};\n```\n\n## async/await\n\n`async/await` 让异步代码读起来像同步代码，极大地提升了可读性。\n\n> **提示**: 始终在 `async` 函数中使用 `try/catch` 来处理错误。\n\n## 关键要点\n\n- Promise 有三种状态：pending、fulfilled、rejected\n- `async/await` 是 Promise 的语法糖\n- 使用 `Promise.all()` 并行执行多个异步操作",
        "category_id": "cat_1",
        "tags": ["JavaScript", "异步", "教程"],
    },
    {
        "id": "a2",
        "title": "设计模式笔记：观察者模式",
        "content": "# 设计模式笔记：观察者模式\n\n观察者模式定义了对象之间的一对多依赖关系。当一个对象的状态发生变化时，所有依赖它的对象都会收到通知并自动更新。\n\n## 核心结构\n\n- **Subject（主题）**: 维护观察者列表，提供添加、删除和通知方法\n- **Observer（观察者）**: 定义更新接口，在收到通知时执行相应操作\n\n## 实际应用\n\n- DOM 事件监听\n- Vue.js 的响应式系统\n- Redux 的 store 订阅机制\n\n## 优势\n\n1. 松耦合：主题和观察者之间是抽象耦合\n2. 广播通信：一对多的消息传递\n3. 动态关系：运行时可以动态添加或删除观察者",
        "category_id": "cat_1",
        "tags": ["设计模式", "JavaScript"],
    },
    {
        "id": "a3",
        "title": "《深入理解计算机系统》阅读笔记",
        "content": "# 《深入理解计算机系统》阅读笔记\n\n## 第 1 章：计算机系统漫游\n\n计算机系统由硬件和系统软件组成，它们共同协作来运行应用程序。\n\n### 信息的编码\n\n所有信息——包括指令、数据、文件——在计算机中都以二进制位表示。\n\n> 核心思想：**抽象**是计算机科学中最重要的概念之一。指令集架构提供了对处理器硬件的抽象；操作系统提供了对 I/O 设备的抽象。\n\n## 关键收获\n\n- Amdahl 定律是评估性能优化的基本工具\n- 存储层次结构利用局部性原理来缩小 CPU 和内存之间的速度差距\n- 操作系统是硬件和应用程序之间的中间层",
        "category_id": "cat_2",
        "tags": ["计算机系统", "CSAPP", "读书"],
    },
    {
        "id": "a4",
        "title": "React 组件设计原则",
        "content": "# React 组件设计原则\n\n好的组件设计是构建可维护 React 应用的基础。\n\n## 单一职责\n\n每个组件应该只负责一个功能。如果一个组件做了太多事情，就应该拆分成更小的组件。\n\n## 组合优于继承\n\nReact 推崇组合模式：\n\n- 使用 `children` prop 传递子元素\n- 使用 render props 共享逻辑\n- 使用自定义 Hook 提取可复用逻辑\n\n## Props 设计\n\n- 保持 Props 接口最小化\n- 使用 TypeScript 定义 Props 类型\n- 为可选 Props 提供合理默认值\n\n## 状态管理\n\n- 状态应该尽可能靠近使用它的组件\n- 避免冗余状态——能计算出来的就不要存储",
        "category_id": "cat_1",
        "tags": ["React", "组件", "最佳实践"],
    },
    {
        "id": "a5",
        "title": "我的开发环境配置",
        "content": "# 我的开发环境配置\n\n记录我的开发环境，方便在新机器上快速搭建。\n\n## 终端\n\n- **Windows Terminal** + PowerShell 7\n- 主题：One Half Dark\n- 字体：Cascadia Code\n\n## VS Code 扩展\n\n- Prettier — 代码格式化\n- ESLint — JavaScript 代码检查\n- GitLens — Git 增强\n- Tailwind CSS IntelliSense\n\n## 常用工具\n\n| 工具 | 用途 |\n|------|------|\n| Git | 版本控制 |\n| Docker | 容器化 |\n| Node.js | JavaScript 运行时 |\n\n## 快捷键\n\n- `Ctrl+Shift+P` — 命令面板\n- `Ctrl+D` — 选择下一个相同词\n- `` Ctrl+` `` — 打开终端",
        "category_id": "cat_3",
        "tags": ["工具", "配置", "效率"],
    },
]


def seed_database():
    """Insert default data if the database is empty. Uses merge to avoid PK conflicts."""
    db = SessionLocal()
    try:
        if db.query(Category).count() == 0:
            for cat in DEFAULT_CATEGORIES:
                db.merge(Category(**cat))
            db.commit()

        if db.query(Article).count() == 0:
            for art in DEFAULT_ARTICLES:
                db.merge(Article(
                    id=art["id"],
                    title=art["title"],
                    content=art["content"],
                    category_id=art["category_id"],
                    tags=json.dumps(art["tags"], ensure_ascii=False),
                ))
            db.commit()
    finally:
        db.close()


# ─── App factory ────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_database()
    yield


app = FastAPI(
    title="Knowledge Base API",
    description="Personal knowledge base — REST API",
    version="1.0.0",
    lifespan=lifespan,
)

cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(articles.router)
app.include_router(categories.router)
app.include_router(tags.router)
app.include_router(entities.router)
app.include_router(stats.router)
app.include_router(graph.router)
app.include_router(qa.router)
app.include_router(upload.router)

# Mount uploads directory — force download to prevent XSS via uploaded HTML/SVG
class _DownloadStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Content-Disposition"] = "attachment"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", _DownloadStaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
