"""
图片解析服务（doubao-seed-2.0-lite 视觉模型）
职责：调用火山方舟视觉模型解析图片
"""
import base64
from typing import Any, Dict, List, cast

from openai import OpenAI

from config import config


def analyze_images(image_urls: List[str], user_question: str = "") -> str:
    """
    分析图片，返回图片解析结果文本
    :param image_urls: 图片 URL 或 base64 列表
    :param user_question: 用户问题（可选）
    :return: 图片解析结果文本
    """
    client = OpenAI(
        api_key=config.Ark.API_KEY,
        base_url=config.Ark.API_URL,
    )

    # 构建消息内容
    content: List[Dict[str, Any]] = [{"type": "text", "text": f"请详细解析这张图片的内容。{user_question}"}]

    for img_url in image_urls:
        # 判断是 URL 还是 base64
        if img_url.startswith("data:image"):
            image_url = img_url
        elif img_url.startswith("http"):
            image_url = img_url
        else:
            # 假设是 base64 编码
            image_url = f"data:image/jpeg;base64,{img_url}"

        content.append({
            "type": "image_url",
            "image_url": {"url": image_url},
        })

    try:
        response = client.chat.completions.create(
            model=config.Ark.VISION_MODEL_ID,
            messages=cast(Any, [{"role": "user", "content": content}]),
            max_tokens=2000,
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"[Vision] 图片解析失败: {e}")
        return f"图片解析失败: {str(e)}"
