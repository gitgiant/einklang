---
name: lab
description: Run a round of Einklang Lab work through the Hauptling delegator - refresh the vote digest, pick pieces, scenes, remixes and fixes from lab/BACKLOG.md and lab/FEEDBACK.md, write the briefs and spawn one worker per vendor. Use when the user asks for a lab round, new visuals, scenes or pieces for Einklang, or says "lab" while delegating in the einklang repo.
---

# Lab round

You are the Hauptling delegator (`/delegator` skill) for `gitgiant/einklang`. This skill adds what to build and how to brief it. Workers follow `lab/AGENTS.md`; don't repeat it in briefs, point at it.

## 1. Refresh the digest

The owner's votes live in their checkout (`C:\Users\giant\Desktop\einklang\data\votes.jsonl`, written by the server). On WSL run the Windows npm there, not Linux node:

```sh
cd /mnt/c/Users/giant/Desktop/einklang
cmd.exe /c "npm run lab -- feedback"
git -c core.autocrlf=true status --short lab/
```

If `lab/feedback.json`, `lab/FEEDBACK.md` or scene files (newly `retired`) changed, commit and push only those to main (`Lab: vote digest`). This is the one edit you make yourself: it is generated bookkeeping, and workers can't see the votes. Make sure the checkout is on a clean `main` first; if it isn't, tell the user and skip the commit (brief from the current digest).

## 2. Read the state

- `lab/FEEDBACK.md`: top and bottom scenes, liked and disliked pieces, top and bottom transitions, vendor scores, reason tags.
- `lab/BACKLOG.md`: pinned briefs first, then unticked catalog items.
- `ls lab/pieces/*/ lab/scenes/ lab/transitions/` for what exists.

## 3. Pick the round

Default: 3 tasks, one per vendor (claude, codex, agy), so the digest can compare them. The user may ask for more or fewer.

Mix by the digest:
- **Pinned briefs** always go first.
- **Fix** a piece the digest lists under "avoid or fix" (edit in place, changelog line, keep params compatible). At most one fix per round.
- **Remix** a top scene (new scene, `parent` set) when one has score >= 2. At most one per round.
- **New work** otherwise: an unticked catalog item, built as its piece(s) **plus a scene that shows it off**. A piece no scene uses never reaches the owner, so every new piece ships with a scene.
- **Transitions** (`### Transitions` in the backlog) are their own folder each (`lab/transitions/<vendor>-<slug>/`, contract in `lab/AGENTS.md`): no scene needed, the gate renders them between two fixed scenes. A task can be "two or three transitions". Transition votes count too: a low-scored one gets a fixed or replacement transition (by its vendor, in its own folder; `core-*` ones are never edited), a high-scored one can be remixed under a new id; brief with its tags and from/to/beats from the digest.
- Spread kinds across the round (not three effects), avoid what the reason tags say the owner dislikes, and lean toward what the liked pieces have in common.
- Give each vendor a different area so branches don't conflict. Only `lab/BACKLOG.md` is shared; ticks on different lines merge fine.

## 4. Brief

One file per task in your scratch dir:

```md
# <vendor>: <what, in a few words>

Repo: einklang. Read lab/AGENTS.md (the contract) and lab/FEEDBACK.md first.

Build: <catalog item or brief, concretely: what it shows, what in the music drives it>
- Piece(s): <kind> `<vendor>-<slug>` ...
- Scene: `<vendor>-<slug>` using it, plus existing pieces as needed (list a few that fit).
<remix: parent `<id>` and what to change / fix: piece `<id>`, what the votes and tags say>

Done: lab/AGENTS.md "Done means". Tick the backlog line.
Test: `npm run lab -- validate`, `npm run lab -- render <id> --fixture all` (look at the sheets), `npm run typecheck`; the GPU gate with `hauptling test request --gpu`.
Don't touch: core-* pieces, src/, scripts/, other vendors' pieces and scenes.
Report: ids, measured ms per piece and scene from the gate, anything unsure.
```

- Add `EINKLANG_IMAGEGEN=<n>` to a brief only when the user asked for AI sprites in this round.
- Ids use the vendor that will do the work: decide the vendor before writing the brief.

## 5. Spawn

`hauptling spawn --delegator <id> --brief <file> --vendor <claude|codex|agy> --model <m>`, one per vendor.

- Model: tier 2 by default (`hauptling models`). Tier 3 for heavy shader or sim work (raymarching, fluids, physics, reaction-diffusion, anything with compute passes or particles).
- The gate needs the GPU (`hauptling gpu status`). If it's paused or busy, say so; workers queue.

Then run the `/delegator` loop. When a round has merged, tell the user which scenes are new, so they can vote on them (gallery: `/gallery.html?scene=<id>`; live: they are in rotation after a rebuild and server restart).
