"""Framework-neutral identifiers and errors for code projects."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ProjectRef:
    project_id: str
    provider: str

    def __post_init__(self) -> None:
        if not isinstance(self.project_id, str) or not self.project_id.strip():
            raise ValueError("project_id must be a non-empty string")
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise ValueError("provider must be a non-empty string")


class ProjectAPIError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
