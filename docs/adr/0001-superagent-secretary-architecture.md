# 0001. Super-agent Secretary Architecture with Intent Routing

To eliminate the human attention bottleneck and prevent concurrent code corruption, we adopt DeepSeek's Super-agent two-tier model: a persistent Secretary (Main Session) handling event triage and isolated Executors running individual Tickets.

## Context

Running agents on demand via chat windows creates a human attention bottleneck (limited to 3-5 concurrent sessions) and leads to code collision when multiple events trigger concurrent edits on the same repository. Furthermore, traditional Webhook setups require external cloud relay servers with public IPs, increasing operational overhead.

## Decision

1. **Ingress Topology**: We use local pull-based Inspection (scheduled API checks) combined with Feishu's long-lived WebSocket connection. This completely eliminates the need for an external cloud server or public IP while allowing real-time bidirectional communication.
2. **Intent Routing**: Instead of hand-written regex routing tables (`rules.json`), we use a Magpie-inspired lightweight classifier model to dynamically analyze task complexity and route requests to optimal downstream models (e.g. flagship reasoning vs. cost-effective utility) and Skill SOPs, backed by default fallback rules.
3. **Concurrency Control via Threads & Subscriptions**: Follow-up messages or rapid updates on the same conversation topic (Thread) are fanned out directly as supplemental inputs to the active Ticket rather than spawning duplicate workers.
4. **Attention-based Human-in-the-Loop**: Executors remain quiet and only escalate structured high-stakes approval questions (Attention) through the Secretary, which presents interactive decision cards on Feishu and resumes execution upon response.

## Consequences

- Zero cloud infrastructure dependency: the entire system runs locally as a DeepSeek Harness plugin.
- Low configuration maintenance: new tasks and models are automatically routed by intent rather than manual code changes.
- Safe execution: workspace-level isolation and Thread subscriptions eliminate Git race conditions and prompt noise.
