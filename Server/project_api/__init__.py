"""Provider-neutral project operations for code workspace integrations."""

from project_api.api import ProjectAPI
from project_api.provider import ProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.resolver import resolve_current_project_ref
from project_api.types import ProjectAPIError, ProjectRef

__all__ = [
    "ProjectAPI",
    "ProjectAPIError",
    "ProjectProvider",
    "ProjectProviderRegistry",
    "ProjectRef",
    "resolve_current_project_ref",
]
