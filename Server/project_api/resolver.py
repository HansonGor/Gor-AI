"""Translate the already-resolved current request project into a provider-neutral ref."""

from project_api.types import ProjectRef


def resolve_current_project_ref(project_id: str | None, provider: str = "preview") -> ProjectRef | None:
    """Resolve an active Preview project ID supplied by the chat request context.

    Session-to-project lookup remains in the chat route. The ProjectProvider never
    receives or looks up a session ID.
    """
    if not isinstance(project_id, str) or not project_id.strip():
        return None
    return ProjectRef(project_id=project_id, provider=provider)
