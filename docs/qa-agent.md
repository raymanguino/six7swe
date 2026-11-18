# QA agent: phase 1 workflow

The QA agent reviews every pull request with an LLM and posts its findings as a
pull request review. It is in **phase 1**: the workflow runs with
`REVIEW_MODE: comment-only`, so it comments but never blocks a merge. Phase 2
(#59) makes it a blocking gate, and only once the calibration criteria on #59
are met.

This page is the routine for phase 1: what happens on its own, and what a person
does to build the evidence for the phase 2 decision.

## What runs on its own

On every non-draft pull request from this repository (not forks), the
`QA Review` workflow (`.github/workflows/qa-review.yml`) runs `qa:review`:

- **It posts a new review on each run.** Earlier reviews are not edited, so the
  pull request keeps the history. The most recent agent review is the current
  verdict.
- **Each finding has an ID.** The ID is shown in the review's table, in the ID
  column. It is unique within one run and names the pull request and commit.
- **It logs one `QA_STATS` line per run** in the workflow log. The line records:
  - the gate outcome, and the outcome `enforce` mode would have returned, with
    its manual-review reasons
  - coverage
  - findings kept and dropped, by reason
  - finding IDs
  - tokens and runtime
  - the prompt version

Nothing here needs a person. The person's job is to judge whether the findings
were right.

## The routine

Do this after a batch of merged pull requests, for example weekly. GitHub
deletes workflow logs after about 90 days, so a finding that is not synced
within that window can no longer be filled in from its run.

All commands run from the repository root. The ones that talk to GitHub need a
token in `GH_TOKEN` or `GITHUB_TOKEN`. The least they need is a fine-grained
personal access token for this repository with read-only **Actions** and
read-only **Pull requests**. With the GitHub CLI, `GH_TOKEN=$(gh auth token)`
works.

### 1. Pull in the new findings

```sh
pnpm --filter @six7swe/backend qa:verdicts --sync > out.md
```

- **What it adds:** one row in `backend/qa/verdicts.json` for every finding ID
  a run logged that the file does not have yet. Each row is filled from the
  review the agent posted for that commit: pull request, commit, severity,
  file, line, message, coverage and prompt version.
- **What it updates:** coverage and prompt version on existing rows, but only
  when the run has a value.
- **What it never changes:** `verdict`, `sameAs` or `note`.
- **What it reports on stderr:** IDs it could not fill in. Either no agent
  review showed them, or the reviews could not be read, in which case try
  again later.
- **How it writes:** it checks the result before writing and writes the file in
  one step. Review the diff before committing.

### 2. Judge the new rows

In each new row in `findings`, fill in the three fields kept by hand:

| Field | What to put |
|---|---|
| `verdict` | For a `blocker` or `major` finding: `real`, `false positive` or `unsure`. For a `minor` or `nit` finding, or a steering finding (`"steering": true`): `useful`, `noise` or `unsure`. Leave it `null` when it is not judged yet. |
| `sameAs` | If this finding re-raises one the agent already posted on an earlier commit of the same pull request, put the **first** sighting's `findingId` here. The row then inherits that verdict, so a finding is judged once. Otherwise `null`. |
| `note` | Why: for example "fixed in `abc1234`", or "the function body was outside the diff". |

Don't edit the other fields; `--sync` owns them.

### 3. Optionally, record what the pull request actually got wrong

Precision says whether the agent's findings were right. It does not say what
the agent missed. That needs ground truth: an entry in `groundTruth` for the
pull request, listing its real defects.

| Field | Meaning |
|---|---|
| `readIndependently` | `true` only if you read the pull request for defects **without** looking at the agent's review first. |
| `defects[].id` | A short lowercase slug, unique in the file. |
| `defects[].severity`, `file`, `description` | The defect itself. |
| `defects[].shownToModel` | Whether its file was in what the model was shown (the review's coverage line). A defect in a file the budget dropped is `missed (unseen)` and is not held against the agent. |
| `defects[].foundBy` | The IDs, or legacy refs, of findings that reported it, each judged `real` or `useful`. Empty means the agent missed it. |

Missed and recall are computed only over pull requests with
`readIndependently: true`. The others are reported as "noticed only": a floor,
not a measurement. Until at least one pull request is read independently, the
report says Missed is "not measured".

### 4. Check, render and publish

```sh
pnpm --filter @six7swe/backend qa:verdicts --check    # validates the file only
pnpm --filter @six7swe/backend qa:verdicts > out.md   # renders the table, reconciled with the runs
```

- `--check` enforces the rules. IDs must be unique. `sameAs` must stay on the
  same pull request and point at the first sighting. The verdict must fit the
  severity. `foundBy` may only credit findings judged `real` or `useful`.
- Commit `backend/qa/verdicts.json` through a pull request, like any change to
  `main`.
- After it merges, replace the "QA agent finding verdicts" comment on #59 with
  `out.md`. Don't edit that comment by hand; it is a rendering of the file.

`--offline` renders from the file alone, without reading GitHub.

## What to look at for the phase 2 decision

| Command | What it reports |
|---|---|
| `qa:verdicts` | Blocker and major **precision** (the #59 target is at least 80%), overall and per prompt version. **Usefulness** of the minor and nit findings. Missed, recall, and a reconciliation of how many posted findings have a verdict. |
| `qa:calibration` | How often the agent **would have blocked** under `enforce`, split into blocking findings and `manual-review` by cause. How often the outcome changed when a commit was reviewed more than once. Runtime, tokens, coverage, and findings dropped by reason. |

Both print Markdown on stdout, and both need the token.

## When the review prompt changes

Findings are only comparable within one prompt version, so precision is reported
per version. When the text of `backend/src/services/ai/prompts/prReview.ts`
changes, add a row to `REVIEW_PROMPT_VERSIONS` in
`backend/src/domain/qa/promptVersion.ts`, and update the hash pinned in its
test. If you forget the bump, the test fails.

## Legacy rows

The 14 findings judged before findings had IDs are kept in `legacy` as
`legacy-1` to `legacy-14`. They count towards precision and usefulness, but they
have no run data, and their coverage and prompt version were reconstructed by
hand. New judgements go in `findings`, not `legacy`.
