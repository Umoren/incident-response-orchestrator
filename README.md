# Incident Response Orchestrator

Samuel's seven-day build of a multi-agent incident responder for a Cloudflare Worker. The main exercise is writing the agent runtime and orchestration ourselves. The project uses the Cloudflare free tier; it does not require billing on the separate Google Cloud project created earlier.

## Layout

```text
incident-response-orchestrator/
├── apps/
│   ├── incident-api/         # Day 1: TypeScript Worker with healthy and broken deployments
│   └── orchestrator/         # Days 2–7: agent runtime, workers, synthesis, approval, deployment
├── docs/
│   ├── days/                 # Daily build notes and experiment results
│   ├── articles/             # The seven article drafts and their publication assets
│   └── architecture/         # System design and operational decisions as they emerge
├── infra/                    # Cloud configuration as the project grows
├── scripts/                  # Traffic generation and repeatable incident/demo commands
└── README.md
```

Create directories as their work begins rather than scaffolding seven days of empty files. Keep the healthy and broken service behaviours reproducible from source, and record deployment IDs and observations in `docs/days/day-01.md` without storing credentials in the repository. The day-by-day platform adaptation is in `docs/architecture/course-map.md`.

Use `docs/days/` for what happened during the build: commands, evidence, failures, and decisions. Develop the daily *Write* pieces in `docs/articles/` using those observations. Follow the writing practices in `../articles/`, `../constitution/taste-constitution.md`, and `../constitution/rubrics/article.md`. Apply ASD-STE100 principles to instructions and explanations: use consistent terms, direct sentences, explicit subjects, and one action per step. Keep Samuel's voice and technical detail; do not claim formal ASD-STE100 compliance without a controlled-language review.
