# feat(routing): introduce deterministic coding-agent virtual routes

## Audit finding
**Severity:** HIGH
**Baseline:** main at f6174cd9caaf4db358b7bb968147864acea59156

The static audit of OmniRoute Lite identified this as a gap against the [project plan](https://github.com/francescogerbasio/OmniRoute-lite). The source points below are starting points for implementation, not proof of runtime behavior or test success.

## Scope / expected remediation
Implement router/planning, router/building, router/visual, router/cheap using explicitly approved provider/model pools, and cover streaming, tool calls, fallback and model listing.

## Relevant source paths
- `src/app/api/v1/models/catalog.ts`
- `open-sse/services/combo`
- `src/app/api/v1/responses/route.ts`

## Acceptance criteria
- [ ] Implementation is isolated from other audit items and preserves intended upstream infrastructure.
- [ ] Focused regression tests cover the expected behavior and important edge cases.
- [ ] `pnpm run typecheck:core` and applicable targeted tests pass on Node 26.
- [ ] `pnpm run build:fast` is validated at a significant checkpoint; no destructive removal without dependency audit.
- [ ] No changes to original `~/.omniroute` data or publication to upstream registries.

> Draft implementation tracking: this PR begins with a scoped checklist, not a claim that the issue is fixed. Review the actual diff and tests before merging.
