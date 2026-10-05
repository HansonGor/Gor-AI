"""Small explicit registry; provider loading is intentionally static."""

from project_api.provider import ProjectProvider
from project_api.types import ProjectAPIError


class ProjectProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, ProjectProvider] = {}

    def register(self, provider_type: str, provider: ProjectProvider) -> None:
        if not isinstance(provider_type, str) or not provider_type.strip():
            raise ValueError("provider_type must be a non-empty string")
        self._providers[provider_type] = provider

    def resolve(self, provider_type: str) -> ProjectProvider:
        provider = self._providers.get(provider_type)
        if provider is None:
            raise ProjectAPIError("UNSUPPORTED_OPERATION", f"项目 Provider 不受支持：{provider_type}")
        return provider
