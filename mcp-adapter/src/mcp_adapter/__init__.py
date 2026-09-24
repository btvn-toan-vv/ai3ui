"""mcp-adapter: FE <-> MCP bridge.

Each connected frontend gets a session with its own spec-compliant MCP
endpoint at ``/{id}/mcp`` (Streamable HTTP), fed by a custom session channel
(SSE handshake + revisioned registry POSTs + tool-call round-trips).
"""

from mcp_adapter.server import create_app

__all__ = ["create_app"]

__version__ = "0.1.0"
