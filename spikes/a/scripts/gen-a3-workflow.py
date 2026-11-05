"""Spike A3: writes workflows/a3-probe.yml with a3-probe.mjs embedded in each job (run from the repo root)."""
import textwrap
from pathlib import Path

here = Path(__file__).resolve().parent
probe = (here / "a3-probe.mjs").read_text()
assert "EOF_PROBE" not in probe and "${{" not in probe
embedded = textwrap.indent(probe, " " * 12).rstrip()

# (job name, permissions block). `none` is `permissions: {}`: metadata read only.
SETS = [
    ("none", None),
    ("pr-write", ["pull-requests: write"]),
    ("issues-write", ["issues: write"]),
    ("contents-read-pr-write", ["contents: read", "pull-requests: write"]),
    ("contents-write", ["contents: write"]),
    ("plan-pr-commands", ["contents: read", "pull-requests: write", "issues: write"]),
]

HEADER = """# Spike A3: run the probe (scripts/a3-probe.mjs, embedded below so no job needs contents: read for a checkout)
# under each permissions block, on every event the action handles. Copy to .github/workflows/ in the sandbox repo.
# Regenerate with: python3 spikes/a/scripts/gen-a3-workflow.py
# A3_LOGINS (repo variable): extra logins to check with the collaborator-permission endpoint, for example the private
# org member and the outside account.
name: A3 probe
on:
  pull_request:
    types: [opened, labeled, synchronize]
  issue_comment:
    types: [created]
  release:
    types: [published]
  push:
    branches: [main]
  workflow_dispatch:
jobs:"""

jobs = []
for name, perms in SETS:
    block = "permissions: {}" if perms is None else "permissions:" + "".join(f"\n      {p}" for p in perms)
    jobs.append(
        f"""  {name}:
    runs-on: ubuntu-latest
    {block}
    steps:
      - env:
          GH_TOKEN: ${{{{ github.token }}}}
          PERMS_LABEL: {name}
          A3_LOGINS: ${{{{ vars.A3_LOGINS }}}}
        run: |
          cat > "$RUNNER_TEMP/a3-probe.mjs" <<'EOF_PROBE'
{embedded}
          EOF_PROBE
          node "$RUNNER_TEMP/a3-probe.mjs\""""
    )

(here.parent / "workflows" / "a3-probe.yml").write_text(HEADER + "\n" + "\n".join(jobs) + "\n")
