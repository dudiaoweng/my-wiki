from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Category, Article
from app.schemas import CategoryCreate, CategoryResponse
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


@router.get("", response_model=list[CategoryResponse])
def list_categories(db: Session = Depends(get_db)):
    return db.query(Category).order_by(Category.name).all()


@router.post("", response_model=CategoryResponse, status_code=201)
def create_category(body: CategoryCreate, db: Session = Depends(get_db)):
    existing = db.query(Category).filter(Category.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Category with this name already exists")

    category = Category(name=body.name, color=body.color)
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    body: CategoryCreate,
    category_id: str = Path(..., max_length=36),
    db: Session = Depends(get_db),
):
    _validate_id(category_id)
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    cat.name = body.name
    cat.color = body.color
    db.commit()
    db.refresh(cat)
    return cat


@router.delete("/{category_id}", status_code=204)
def delete_category(
    category_id: str = Path(..., max_length=36),
    db: Session = Depends(get_db),
):
    _validate_id(category_id)
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")

    # Check if any articles belong to this category
    article_count = db.query(Article).filter(Article.category_id == category_id).count()
    if article_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"该分类下还有 {article_count} 篇文章，请先移除或转移文章后再删除",
        )

    db.delete(cat)
    db.commit()
    return None
