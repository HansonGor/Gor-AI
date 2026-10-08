"""Request-scoped composition for the currently resolved Preview project."""

from typing import Any

from project_api.api import ProjectAPI
from project_api.providers.preview import PreviewProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.resolver import resolve_current_project_ref
from project_api.types import ProjectRef
from services.preview_project_service import PreviewProjectService


def create_current_preview_project_api(workspace: Any) -> tuple[ProjectAPI, ProjectRef] | None:
    if workspace is None:
        return None
    project_ref = resolve_current_project_ref(getattr(workspace, "project_id", None))
    if project_ref is None:
        return None
    provider = PreviewProjectProvider(PreviewProjectService(workspace))
    registry = ProjectProviderRegistry()
    registry.register("preview", provider)
    return ProjectAPI(registry), project_ref
