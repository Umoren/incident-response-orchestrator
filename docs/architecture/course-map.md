# Seven-day course map — Cloudflare edition

The engineering objective stays the same: build a multi-agent incident response orchestrator without using an agent framework to hide the control loop. The Cloudflare free tier replaces Google Cloud because this project cannot use a billed Google Cloud project. Each participant uses a separate Cloudflare account or separate named resources and deployments.

| Day | Build and learn |
| --- | --- |
| 1 | Deploy a public quote API Worker twice: healthy, then broken. Send repeatable traffic; inspect deployment versions, Workers Logs, HTTP results, and an explicit error-rate check. |
| 2 | Write `runAgent()` with Workers AI as the model provider. Add read-only tools for the evidence we actually collect: quote events, error counts, and deployment metadata. Keep tool errors and step limits explicit. |
| 3 | Add delegation with scoped context and tool access. A telemetry worker examines errors; a deployment worker examines version history. Give each its own conversation history. |
| 4 | Run independent workers concurrently and persist incident, run, agent, and task records in D1. Test timeouts, duplicate notifications, and failed workers. |
| 5 | Merge structured findings with sourced evidence; check disagreement and uncertainty before proposing an action. |
| 6 | Require human approval before a separate remediation component changes the live Worker version. Verify recovery with fresh requests and evidence. Keep deployment credentials out of investigation tools. |
| 7 | Run full scenarios, record structured transitions, and deploy a complete demonstration. |

## Evidence boundaries

Workers Logs and the Cloudflare dashboard support Day 1 manual investigation. Workers Logs on the free plan has limited retention; write the observed times and version IDs in the daily notes. A synthetic checker can report HTTP error rate based on its own requests; it is not a platform-wide alert. Before Day 2, add a small durable event record in D1 so read-only agent tools can query the same evidence consistently. The exact storage and query contract is a Day 2 design decision.

Workers AI has a free daily allocation and stops serving inference when the free quota is exhausted. Keep model calls bounded and log usage. D1, Workers, and Workers Logs also have free-plan limits; see [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) before running large tests.

Do not call Workers Logs "Cloud Logging", D1 "Firestore", Workers AI "Vertex AI", or a synthetic checker "Cloud Monitoring". The investigation and orchestration lessons transfer; the platform APIs and deployment controls are different.
