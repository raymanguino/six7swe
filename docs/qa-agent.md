# QA agent

The QA agent reviews every pull request with an LLM (MiniMax) and posts its
findings as a pull request review. The plan is tracked in epic #51. This page is
the handover: what exists, where it stands, what is left, and the routine that
gets it to done.

It is in **phase 1**: the workflow runs with `REVIEW_MODE: comment-only`, so
the agent comments but never blocks a merge. **Phase 2** (#59) makes its
`QA agent review` check a blocking gate. Phase 2 is a one-word change. Deciding
to make it is the remaining work.

## How it works

```
pull request opened / pushed / edited / marked ready
  -> .github/workflows/qa-review.yml           job "QA agent review"
       checks out base.sha                     the agent's code is never the PR's code
       pnpm --filter @six7swe/backend qa:review   (backend/scripts/review-pr.ts)
         reads the diff through the GitHub REST API
         builds a bounded, tiered diff         backend/src/domain/qa/diff.ts
         asks MiniMax for findings             backend/src/services/ai/prompts/prReview.ts
         sanitizes them against what the model was shown, decides the gate
                                               backend/src/domain/qa/verdict.ts
         posts one review with GITHUB_TOKEN, logs one QA_STATS line
       exit 1 only when the gate blocks        never, in comment-only mode
```

- **The gate is a required status check, not an approval.** `main` is
  protected by ruleset `12656541`, which requires `Lint, test and build` and
  `QA agent review`. The agent never approves. The admin bypass on the ruleset
  is the escape hatch for a false positive or an outage. Why a check and not
  an approval is recorded on #51.
  - **Don't rename either job without updating the ruleset.** A required
    check is matched by the job's `name:`, not the workflow's. A renamed job
    never reports, so every pull request waits on a check that never comes.
  - Both checks are tied to the GitHub Actions integration
    (`integration_id: 15368`). If a check is ever reported by something else,
    such as the GitHub App from #52, re-add it without the integration.
- **Gate outcomes** (`decideGate` in `verdict.ts`):
  - `pass`
  - `fail`: a `blocker` or `major` finding
  - `manual-review`: the pull request touches a protected path, or the diff
    budget dropped whole files
  - `fail-closed`: the review could not be completed

  In `comment-only` mode, every outcome exits 0.

- **Protected paths** (`DEFAULT_PROTECTED_PATTERNS` in `verdict.ts`) cover the
  workflows, the agent's own code, the schema and migrations, the auth code,
  and the dependency manifests, including `pnpm-lock.yaml`. A pull request
  that touches one always gets `manual-review`, whatever the model says.
- **Skipped runs.** Drafts and fork pull requests are skipped, and a skipped
  required check counts as passing. Dependabot pull requests are reviewed:
  `MINIMAX_API_KEY` is in the Dependabot secret store too.

## Status (2026-11-18)

**The build is finished.** 20 of the 21 child issues of #51 are closed. They
include every prerequisite #59 names: #93, and #141 to #146. #58, the gate on
`main`, closed on 2026-11-18. How it was verified is in
[its closing comment](https://github.com/raymanguino/six7swe/issues/58#issuecomment-6984244891).

The one open child is #59, and it is not code:

| Issue | What is left                                                                | Size                    |
| ----- | --------------------------------------------------------------------------- | ----------------------- |
| #59   | Collect and judge enough instrumented runs to decide the flip, then flip it | Weeks of normal PR flow |

### Where calibration stands

These numbers are from `qa:calibration` and `qa:verdicts`, run against `main`
on 2026-11-18. Re-run them for current figures (see
[What to look at](#what-to-look-at-for-the-phase-2-decision)).

| #59 criterion                                       | Now                                                                             | Met?          |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| 20+ PRs reviewed, 5+ backend, 5+ frontend           | 72 PRs (48 backend, 14 frontend)                                                | Yes           |
| 80%+ of blocker/major findings real                 | 3 of 7 judged (43%)                                                             | No            |
| minor/nit findings are useful, not noise            | 5 useful, 1 noise                                                               | Leaning yes   |
| No finding on a file or line the model wasn't shown | Enforced in code since #141. Few runs log the counters yet                      | Not yet shown |
| Runtime acceptable                                  | 27.5 s average, 303 s max, against a 15 min timeout                             | Yes           |
| Enforce-mode outcome known for every PR             | Recorded on 2 runs                                                              | No            |
| Same-commit disagreement known and low              | Findings changed on 6 of 20 re-reviewed commits (30%). Enforce outcome: no data | No            |

**What this means.** The volume criterion is met. The criteria that matter
are not, and most of them could not be measured until today:

- Finding IDs, the enforce-mode outcome and the verdict file (#143 to #146)
  were merged on 2026-11-18.
- Of the 56 findings posted so far, none has an ID. Only the 14 judged by hand
  (the `legacy` rows) count, and 42 will never be judged.
- **The real calibration sample starts now.** Count only runs from
  2026-11-18 onward.

**Two early signals to watch:**

1. **Precision.** Four of the five wrong findings came from the model judging
   code it was not shown: a function body outside the diff, a library default,
   or a line outside the patch context. If precision stays low on the new
   sample, change the prompt or the context. Don't flip.
2. **Variance.** 30% of re-reviewed commits got a different set of findings,
   with no code change. A gate whose verdict changes on a re-run is not ready.

## Finishing #59

### 1. Build the sample

Let ordinary pull request traffic run, and run [the routine](#the-routine)
weekly. Before deciding, aim for all of these (a proposed bar; record it on
#59 before you start):

- **20 or more pull requests** reviewed since 2026-11-18, so every one has
  finding IDs and an enforce-mode outcome
- **15 or more judged `blocker`/`major` findings** on the current prompt
  version. At 7 findings, a percentage doesn't tell you much.
- **3 or more pull requests read independently**, `readIndependently: true`,
  so misses and recall have a value
- **Re-runs on 10 or more commits.** Re-run the job on commits that already
  have a review: `gh run rerun <run-id>`, or **Re-run jobs** in Actions.
  Organic re-runs are too rare to measure variance. Each re-run costs one
  MiniMax call.

### 2. Decide

Flip when `qa:verdicts` and `qa:calibration`, over the new sample, show:

- at least 80% blocker/major precision
- an enforce-mode outcome that rarely changes between runs of the same commit:
  #59 says a few percent at most
- a would-have-blocked rate that is mostly real defects. Every
  `manual-review` (a protected path or a dropped file) is a red check the
  owner clears by hand.

Before the flip, know these two consequences:

- **Every Dependabot pull request touches `pnpm-lock.yaml`.** After the flip,
  each one goes red and needs the admin bypass.
- **About 22% of reviews so far dropped whole files.** Each of those becomes
  `manual-review`.

If either costs too much, change the protected-path list or the diff budget
first. If precision misses the bar, these levers come first:

- a prompt change: bump the prompt version (see
  [When the review prompt changes](#when-the-review-prompt-changes)), which
  starts a new per-version sample
- treating `major` as non-blocking: `BLOCKING_SEVERITIES` in `verdict.ts`

Post the numbers, and the decision, on #59.

### 3. Flip

In `.github/workflows/qa-review.yml`, change `REVIEW_MODE: comment-only` to
`REVIEW_MODE: enforce`. The pull request is itself on a protected path, so it
gets a red check. Merge it with the bypass. No ruleset change is needed.

Then check the remaining #59 acceptance boxes on real pull requests:

- red on a real defect, green on a clean one
- red on a protected path even with no findings
- the owner can merge a red-checked pull request with the bypass (moved here
  from #58)
- a push re-runs the check against the new head SHA

### Rollback

Pick one:

- **Back to comment-only:** set `REVIEW_MODE` back to `comment-only` and
  merge with the bypass.
- **Disable the workflow:** **Actions -> QA Review -> Disable workflow**. A
  check that never runs reads as passing.
- **Remove the check:** delete `QA agent review` from the ruleset's required
  checks.

## The routine

Do this weekly, or after each batch of merged pull requests. GitHub deletes
workflow logs after about 90 days, and some are already gone. A finding not
synced inside that window can no longer be filled in from its run.

All commands run from the repository root. The ones that talk to GitHub need a
token in `GH_TOKEN` or `GITHUB_TOKEN`: either a fine-grained token with
read-only **Actions** and **Pull requests**, or `GH_TOKEN=$(gh auth token)`.
GitHub sometimes answers `502` while the scripts page through runs. Run the
command again.

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

| Field     | What to put                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict` | For a `blocker` or `major` finding: `real`, `false positive` or `unsure`. For a `minor` or `nit` finding, or a steering finding (`"steering": true`): `useful`, `noise` or `unsure`. Leave it `null` when it is not judged yet.         |
| `sameAs`  | If this finding re-raises one the agent already posted on an earlier commit of the same pull request, put the **first** sighting's `findingId` here. The row then inherits that verdict, so a finding is judged once. Otherwise `null`. |
| `note`    | Why: for example "fixed in `abc1234`", or "the function body was outside the diff".                                                                                                                                                     |

Don't edit the other fields; `--sync` owns them. In the note, say whether a
wrong finding depended on code the model was not shown. That is the main
pattern so far.

### 3. Record what the pull request actually got wrong

Precision says whether the agent's findings were right. It does not say what
the agent missed. That needs ground truth: an entry in `groundTruth` for the
pull request, listing its real defects. #59 needs a few of these (see
[Build the sample](#1-build-the-sample)).

| Field                                       | Meaning                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readIndependently`                         | `true` only if you read the pull request for defects **without** looking at the agent's review first.                                                                        |
| `defects[].id`                              | A short lowercase slug, unique in the file.                                                                                                                                  |
| `defects[].severity`, `file`, `description` | The defect itself.                                                                                                                                                           |
| `defects[].shownToModel`                    | Whether its file was in what the model was shown (the review's coverage line). A defect in a file the budget dropped is `missed (unseen)` and is not held against the agent. |
| `defects[].foundBy`                         | The IDs, or legacy refs, of findings that reported it, each judged `real` or `useful`. Empty means the agent missed it.                                                      |

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

| Command          | What it reports                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qa:verdicts`    | Blocker and major **precision** (the #59 target is at least 80%), overall and per prompt version. **Usefulness** of the minor and nit findings. Missed, recall, and a reconciliation of how many posted findings have a verdict.                           |
| `qa:calibration` | How often the agent **would have blocked** under `enforce`, split into blocking findings and `manual-review` by cause. How often the outcome changed when a commit was reviewed more than once. Runtime, tokens, coverage, and findings dropped by reason. |

Both print Markdown on stdout, and both need the token. `qa:calibration`
counts every run it can still read, including the ones from before the
instrumentation. Its footer says how many runs it had to skip, for each
missing field.

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

## Housekeeping

- **Unused secrets.** The Actions secrets include `QA_REVIEWER_TOKEN` and
  `QA_APP_PRIVATE_KEY`, and the workflow reads neither.
  - `QA_APP_PRIVATE_KEY` is the GitHub App key from #52. It is only needed
    for the optional "phase 2.5" visible approval.
  - Any workflow a same-repository pull request edits can read every Actions
    secret. A durable credential that nothing uses is pure exposure. Delete
    `QA_REVIEWER_TOKEN`, and the app key too unless phase 2.5 is planned.
- **The workflow file is controlled by the pull request.** On a
  `pull_request` event, GitHub runs the workflow from the PR's merge ref. A
  pull request can edit `qa-review.yml` to skip the gate. The protected-path
  rule makes that pull request `manual-review` after the flip, but the edited
  workflow decides its own exit code. This is accepted for a solo repository
  (#51, #57).
