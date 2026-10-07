"""Request-scoped composition for a VS Code workspace ProjectRef."""

from project_api.api import ProjectAPI
from project_api.providers.vscode import VSCodeProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.resolver import resolve_current_project_ref
from project_api.types import ProjectRef


def create_current_vscode_project_api(workspace_id: str | None) -> tuple[ProjectAPI, ProjectRef] | None:
    if not isinstance(workspace_id, str) or not workspace_id.startswith("vscode-"):
        return None
    project_ref = resolve_current_project_ref(workspace_id, provider="vscode")
    if project_ref is None:
        return None
    registry = ProjectProviderRegistry()
    registry.register("vscode", VSCodeProjectProvider())
    return ProjectAPI(registry), project_ref
