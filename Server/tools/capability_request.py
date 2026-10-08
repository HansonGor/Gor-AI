"""Schema only; capability negotiation is handled by the request-scoped Agent."""

from langchain_core.tools import tool


@tool
def request_tools(tool_names: list[str], reason: str, subtask: str = "") -> str:
    """Request existing tools needed for a subtask when current tools are insufficient.

    Consult the supplied capability catalog. Use tool names or catalog group names;
    several tools may be requested together for compound tasks. Give a short reason
    and subtask, not source code, credentials, or paths. This only loads tools; it
    does not execute the task. The response distinguishes added, already available,
    and unavailable tools with reasons. Continue with existing tools when a request
    is unavailable, do not retry the same denial, and explain actual partial results
    briefly at the end. It cannot grant permissions, install tools, or change hosts.
    Newly added tools can be called on the next model turn, not in this same batch.
    """
    return '{"success":false,"code":"AGENT_CONTEXT_REQUIRED"}'
