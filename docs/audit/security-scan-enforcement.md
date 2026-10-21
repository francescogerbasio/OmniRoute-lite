# ci(security): enforce repository security checks

## Audit finding
**Severity:** MEDIUM
**Baseline:** main at f6174cd9caaf4db358b7bb968147864acea59156

The static audit of OmniRoute Lite identified this as a gap against the [project plan](https://github.com/francescogerbasio/OmniRoute-lite). The source points below are starting points for implementation, not proof of runtime behavior or test success.

## Scope / expected remediation
Make high-confidence security findings blocking, keep credentials scanning, resolve CodeQL default vs advanced setup configuration and verify required check coverage without duplicated scans.

## Relevant source paths
- `.github/workflows/semgrep.yml`
- `.github/workflows/codeql.yml`
- `.github/workflows/ci.yml`

## Acceptance criteria
- [ ] Implementation is isolated from other audit items and preserves intended upstream infrastructure.
- [ ] Focused regression tests cover the expected behavior and important edge cases.
- [ ] `pnpm run typecheck:core` and applicable targeted tests pass on Node 26.
- [ ] `pnpm run build:fast` is validated at a significant checkpoint; no destructive removal without dependency audit.
- [ ] No changes to original `~/.omniroute` data or publication to upstream registries.

> Draft implementation tracking: this PR begins with a scoped checklist, not a claim that the issue is fixed. Review the actual diff and tests before merging.
