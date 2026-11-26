# Einklang: notes for agents

Deterministic, synced WebGPU music visualizer (WebGPU only, no WebGL fallback). Design: `SPEC.md`; lab (agent-built pieces, node graph, voting): `docs/prd-lab.md`; current state and gotchas: `HANDOFF.md`.

- **Building visuals (pieces, scenes, style packs)?** Follow `lab/AGENTS.md`: it is the contract. What to build: `lab/BACKLOG.md`; what the owner likes: `lab/FEEDBACK.md`.
- **Delegating lab work through Hauptling?** Use the `lab` skill (`.agents/skills/lab/SKILL.md`, the same file as `.claude/skills/lab/SKILL.md`: keep them identical).
- Checks: `npm run typecheck`, `npm test`, `npm run lab -- validate`; GPU: `npm run lab -- gate` (via `hauptling test request --gpu` in a worker).
