from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Category, Article
from app.schemas import CategoryCreate, CategoryMove, CategoryResponse
from app.auth import get_client_cert, CertInfo
import uuid

router = APIRouter(prefix="/api/categories", tags=["categories"])


def _validate_id(cat_id: str) -> None:
    """Validate category ID — accepts UUIDs and legacy short IDs (e.g. 'cat_1')."""
    if not cat_id or len(cat_id) > 36:
        raise HTTPException(status_code=400, detail="Invalid category ID format")
    if len(cat_id) == 36 and '-' in cat_id:
        try:
            uuid.UUID(cat_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid category ID format")


def _validate_parent(db: Session, parent_id: str, self_id: str | None = None) -> None:
    """校验上级目录：存在、不能是自身、不能是自己的子孙（防环）。"""
    parent = db.query(Category).filter(Category.id == parent_id).first()
    if not parent:
        raise HTTPException(status_code=400, detail="上级目录不存在")
    if self_id is not None:
        cur_id: str | None = parent_id
        seen: set[str] = set()
        while cur_id and cur_id not in seen:
            if cur_id == self_id:
                raise HTTPException(status_code=400, detail="不能挂载到自己的子目录下")
            seen.add(cur_id)
            cur = db.query(Category).filter(Category.id == cur_id).first()
            cur_id = cur.parent_id if cur else None


@router.get("", response_model=list[CategoryResponse])
def list_categories(db: Session = Depends(get_db)):
    return db.query(Category).order_by(Category.name).all()


@router.get("/article-counts")
def category_article_counts(db: Session = Depends(get_db)):
    """每个目录的递归文章数（含所有子目录），返回 {category_id: count}。

    文章列表根目录视图（「全部」= 根目录，展示顶级目录及文章数徽章）用。
    """
    from sqlalchemy import func

    rows = (
        db.query(Article.category_id, func.count(Article.id))
        .group_by(Article.category_id)
        .all()
    )
    direct = dict(rows)

    cats = db.query(Category).all()
    by_parent: dict[str | None, list[Category]] = {}
    for c in cats:
        by_parent.setdefault(c.parent_id, []).append(c)

    result: dict[str, int] = {}
    seen: set[str] = set()

    def walk(cat_id: str) -> int:
        if cat_id in seen:
            return 0  # 数据异常成环防御
        seen.add(cat_id)
        total = direct.get(cat_id, 0)
        for sub in by_parent.get(cat_id, []):
            total += walk(sub.id)
        result[cat_id] = total
        return total

    for c in cats:
        if not c.parent_id:
            walk(c.id)
    return result


@router.post("", response_model=CategoryResponse, status_code=201)
def create_category(body: CategoryCreate, db: Session = Depends(get_db),
                    cert: CertInfo = Depends(get_client_cert)):
    existing = db.query(Category).filter(Category.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Category with this name already exists")

    if body.parent_id:
        _validate_parent(db, body.parent_id)

    category = Category(
        name=body.name, color=body.color,
        parent_id=body.parent_id or None,
        created_by=cert.display_name or None,
    )
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    body: CategoryCreate,
    category_id: str = Path(..., max_length=36),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    _validate_id(category_id)
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    user_cn = cert.display_name or ""
    if cat.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有创建人可以编辑该目录")
    existing = db.query(Category).filter(
        Category.name == body.name, Category.id != category_id
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Category with this name already exists")

    # 上级目录：None = 保持不变；空串 = 移到顶级；ID = 校验后挂载（同自身/子孙拒绝）
    if body.parent_id is not None:
        if body.parent_id == "":
            cat.parent_id = None
        elif body.parent_id != (cat.parent_id or ""):
            _validate_parent(db, body.parent_id, self_id=category_id)
            cat.parent_id = body.parent_id

    cat.name = body.name
    cat.color = body.color
    db.commit()
    db.refresh(cat)
    return cat


@router.post("/{category_id}/move", response_model=CategoryResponse)
def move_category(
    category_id: str = Path(..., max_length=36),
    body: CategoryMove = Body(...),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """拖拽移动目录：空串 = 移到顶级，否则挂到目标目录下（创建人 only）。"""
    _validate_id(category_id)
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Directory not found")
    user_cn = cert.display_name or ""
    if cat.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有创建人可以移动该目录")

    target = body.parent_id or ""
    if target == "":
        cat.parent_id = None
    elif target != (cat.parent_id or ""):
        _validate_parent(db, target, self_id=category_id)
        cat.parent_id = target
    db.commit()
    db.refresh(cat)
    return cat


@router.delete("/{category_id}", status_code=204)
def delete_category(
    category_id: str = Path(..., max_length=36),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    _validate_id(category_id)
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    user_cn = cert.display_name or ""
    if cat.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有创建人可以删除该目录")

    # 有子目录时拒绝删除
    child_count = db.query(Category).filter(Category.parent_id == category_id).count()
    if child_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"该目录下还有 {child_count} 个子目录，请先移动或删除子目录",
        )

    # Check if any articles belong to this category
    article_count = db.query(Article).filter(Article.category_id == category_id).count()
    if article_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"该目录下还有 {article_count} 篇文章，请先移除或转移文章后再删除",
        )

    db.delete(cat)
    db.commit()
    return None
