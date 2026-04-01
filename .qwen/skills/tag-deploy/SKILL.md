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
1. ✅ Run pre-flight checks automatically (git status, branch, CI workflows)
2. ✅ Suggest next version (patch increment)
3. ⏸️ **Ask you to confirm the version** (only question!)
4. ✅ Create and push tag
5. ✅ Monitor workflows silently (no intermediate prompts)
6. ✅ Show final report

---

## Workflow Summary

| Step | Description | User Action |
|------|-------------|-------------|
| 1 | Pre-flight checks | None (automatic) |
| 2 | Suggest version | **Confirm or enter custom version** |
| 3 | Push tag | None (automatic) |
| 4 | Monitor workflows | None (automatic, may take several minutes) |
| 5 | Final report | None (automatic) |

---

## Example Session

```
✅ Pre-flight checks passed (CI & Integration tests successful)
Latest tag: v0.3.9
Suggested: v0.3.10

[User confirms version]

✅ Tag v0.3.10 created and pushed
⏳ Monitoring workflows... (this takes a few minutes)

🎉 Release v0.3.10 complete!
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
