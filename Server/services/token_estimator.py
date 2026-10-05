"""Lightweight tokenizer utility shared by context and Preview services."""

import tiktoken


_encoding = tiktoken.get_encoding("cl100k_base")


def estimate_tokens(text: str) -> int:
    """Estimate tokens with the project's existing cl100k_base tokenizer."""
    return len(_encoding.encode(text or "", disallowed_special=()))
