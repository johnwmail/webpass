---
name: tag-deploy
description: Create release tags with GitHub Actions monitoring. Use `/skill` or `/skill tag-deploy` to invoke. Verifies CI passes, auto-increments version, monitors build/deploy workflows.
---

# Skill: Tag & Deploy for WebPass

Project-specific skill for creating release tags with full GitHub Actions monitoring.

---

## Purpose

Automate the release process for WebPass by:
1. Verifying CI passes before tagging
2. Auto-incrementing version numbers
3. Monitoring all GitHub Actions workflows
4. Providing clear success/failure reports

---

## Usage

```bash
# Run the skill - only ONE confirmation needed
/skill tag-deploy
```

**The skill will:**
1. ⏸️ **Ask you to confirm the version FIRST** (ONLY QUESTION!)
2. ✅ Run pre-flight checks automatically (git status, branch, CI workflows)
3. ✅ Wait for CI to complete (automatic, silent)
4. ✅ Create and push tag (automatic)
5. ✅ Monitor release workflows (automatic, silent)
6. ✅ Show final report (automatic)

**Important:** Version confirmation happens FIRST - before any waiting. After confirmation, ALL steps run automatically with no further prompts.

---

## Workflow Summary

| Step | Description | User Action |
|------|-------------|-------------|
| 1 | **Ask version** | **Confirm or enter custom version** (ONLY interaction) |
| 2 | Pre-flight checks | None (fully automatic) |
| 3 | Wait for CI | None (fully automatic, may take minutes) |
| 4 | Push tag | None (fully automatic) |
| 5 | Monitor workflows | None (fully automatic, silent) |
| 6 | Final report | None (fully automatic) |

---

## Example Session

```
Latest tag: v0.3.10
Suggested: v0.3.11

[User confirms version: v0.3.11]

✅ Pre-flight checks passed (CI & Integration tests successful or in-progress)
⏳ Waiting for CI workflows to complete... (this takes a few minutes)
✅ Tag v0.3.11 created and pushed
⏳ Monitoring release workflows... (silent, no prompts)

🎉 Release v0.3.11 complete!
```

---

## Requirements

- `gh` CLI installed and authenticated
- Write access to repository
- Main branch protection allows tag pushes

---

## Troubleshooting

### CI Workflows Failed

```bash
# View failed runs
gh run list --branch main --status failure --limit 5

# View specific failure
gh run view <RUN_ID> --log
```

### Tag Already Exists

```bash
# Delete local and remote tag (careful!)
git tag -d v0.3.10
git push origin :refs/tags/v0.3.10

# Then retry
```

### Workflows Not Triggering

- Check tag format: must be `v*` (e.g., `v0.3.10`)
- Verify tag was pushed: `git push origin v0.3.10`
- Check GitHub Actions is enabled for repo

---

## Related Files

- `.github/workflows/ci.yml` - CI checks
- `.github/workflows/integration-test.yml` - E2E tests
- `.github/workflows/build-container.yml` - Docker build
- `.github/workflows/deploy.yml` - Cloudflare deployment
