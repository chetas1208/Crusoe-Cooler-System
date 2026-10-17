"""V11 model gateway: catalog discovery, capability probes, rate/concurrency/spend limits, retries, circuit breaker, audit rows."""
from .config import GatewayConfig, ROLES, role_for_kind  # noqa: F401
from .gateway import GatewayError, ModelGateway, GatewayResult  # noqa: F401
