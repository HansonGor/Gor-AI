"""
模型额度管理模块
职责：模型名称映射、额度查询、额度扣减
"""
from typing import Optional

from config import config
from db.supabase_chat import get_pool

# 模型 ID 到显示名称的映射
MODEL_NAME_MAP = {
    "ep-20260902232204-6rhbl": "DeepSeek‑V4‑Flash正式版",
    # 当前接入点，实际模型为 deepseek-v4-1-flash（2026-10-17 由接口返回的 model 字段确认）
    "ep-20260923135013-dx9tw": "DeepSeek V4.1 Flash",
    "deepseek-v4-pro": "DeepSeek‑V4‑Pro",
    "deepseek-v4-flash": "DeepSeek‑V4‑Flash正式版",
}


def get_model_display_name(model_id: str) -> str:
    """获取模型显示名称"""
    return MODEL_NAME_MAP.get(model_id, model_id)


async def get_model_quota(model_name: str) -> Optional[dict]:
    """查询模型剩余额度"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT model_name, remain_quota, updated_at FROM model_quota WHERE model_name = $1",
            model_name,
        )
        return dict(row) if row else None


async def deduct_model_quota(model_name: str, total_tokens: int) -> Optional[dict]:
    """
    扣减模型额度
    返回：{model_name, old_remain, cost_total, new_remain}
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        # 查询旧额度
        row = await conn.fetchrow(
            "SELECT remain_quota FROM model_quota WHERE model_name = $1",
            model_name,
        )
        if not row:
            print(f"[ModelQuota] 模型 {model_name} 不在额度表中，跳过扣减")
            return None

        old_remain = row["remain_quota"]
        new_remain = old_remain - total_tokens

        # 更新额度
        await conn.execute(
            "UPDATE model_quota SET remain_quota = $1, updated_at = NOW() WHERE model_name = $2",
            new_remain, model_name,
        )

        result = {
            "model_name": model_name,
            "old_remain": old_remain,
            "cost_total": total_tokens,
            "new_remain": new_remain,
        }
        print(f"[ModelQuota] {model_name}: {old_remain} - {total_tokens} = {new_remain}")
        return result
