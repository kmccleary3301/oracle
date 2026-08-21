#!/usr/bin/env bash
set -euo pipefail

# Oracle release helper (npm)
# Phases: gates | artifacts | publish | smoke | tag | all
# Defaults to using the guardrail runner (MCP_RUNNER or ./runner).

RUNNER="${MCP_RUNNER:-./runner}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 

if [[ "${CODEX_MANAGED_BY_NPM:-}" == "1" ]]; then
  export NPM_CONFIG_PROGRESS=false
  export npm_config_progress=false
fi

banner() { printf "\n==== %s ====" "$1"; printf "\n"; }
run() { echo ">> $*"; "$@"; }

phase_promotion_gate() {
  banner "Promotion evidence gate"
  local evidence_dir="${RELEASE_EVIDENCE_DIR:-.release-evidence}"
  local proof_mode="${RELEASE_PROOF_MODE:-bounded}"
  local required_runs="${RELEASE_REQUIRED_SOAK_RUNS:-3}"
  local required_duration="${RELEASE_REQUIRED_SOAK_DURATION_MS:-28800000}"
  local max_age="${RELEASE_EVIDENCE_MAX_AGE_MS:-172800000}"
  local commit="${RELEASE_EVIDENCE_COMMIT:-${GITHUB_SHA:-}}"
  local repository="${RELEASE_EVIDENCE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
  local workflow="${RELEASE_EVIDENCE_WORKFLOW:-${GITHUB_WORKFLOW:-}}"
  local run_id="${RELEASE_EVIDENCE_RUN_ID:-${GITHUB_RUN_ID:-}}"
  local supplemental_run_id="${RELEASE_EVIDENCE_SUPPLEMENTAL_RUN_ID:-}"
  local source_ref="${RELEASE_EVIDENCE_SOURCE_REF:-${GITHUB_REF:-}}"
  local trusted_key="${RELEASE_TRUSTED_PUBLIC_KEY:-}"
  if [[ -z "$commit" ]]; then
    echo "Promotion evidence commit is required (set RELEASE_EVIDENCE_COMMIT or GITHUB_SHA)" >&2
    return 1
  fi
  if [[ -z "$trusted_key" && ( -z "$repository" || -z "$workflow" || -z "$run_id" || -z "$source_ref" ) ]]; then
    echo "Promotion evidence requires complete repository/workflow/run/source-ref provenance or RELEASE_TRUSTED_PUBLIC_KEY" >&2
    return 1
  fi
  if [[ ! -d "$evidence_dir" ]]; then
    echo "Promotion evidence directory is missing: $evidence_dir" >&2
    return 1
  fi
  local gate_args=(
    --evidence-dir "$evidence_dir"
    --mode "$proof_mode"
    --required-soak-runs "$required_runs"
    --required-soak-duration-ms "$required_duration"
    --max-age-ms "$max_age"
    --commit "$commit"
  )
  [[ -n "$repository" ]] && gate_args+=(--repository "$repository")
  [[ -n "$workflow" ]] && gate_args+=(--workflow "$workflow")
  [[ -n "$run_id" ]] && gate_args+=(--run-id "$run_id")
  [[ -n "$supplemental_run_id" ]] && gate_args+=(--supplemental-run-id "$supplemental_run_id")
  [[ -n "$source_ref" ]] && gate_args+=(--source-ref "$source_ref")
  [[ -n "$trusted_key" ]] && gate_args+=(--trusted-key "$trusted_key")
  run "$RUNNER" pnpm release:promotion-gate "${gate_args[@]}"
}

phase_gates() {
  banner "Gates (check/lint/test/build)"
  run "$RUNNER" pnpm run check
  run "$RUNNER" pnpm run lint
  run "$RUNNER" pnpm run test
  run "$RUNNER" pnpm run build
  phase_promotion_gate
}


phase_artifacts() {
  banner "Artifacts (npm pack + checksums)"
  run "$RUNNER" pnpm run build
  run "$RUNNER" npm pack --pack-destination /tmp

  # npm pack tarballs are not consistent for scoped packages:
  # - @scope/name -> scope-name-x.y.z.tgz
  # - name        -> name-x.y.z.tgz
  local packed
  packed=$(ls -1 "/tmp/"*"${VERSION}.tgz" 2>/dev/null | head -n1 || true)
  if [[ -z "${packed:-}" ]]; then
    echo "No tgz found in /tmp after npm pack" >&2
    exit 1
  fi

  local tgz="oracle-${VERSION}.tgz"
  mv "$packed" "$tgz"
  run shasum "$tgz"
  shasum "$tgz" > "${tgz}.sha1"
  run shasum -a 256 "$tgz"
  shasum -a 256 "$tgz" > "${tgz}.sha256"
}

phase_publish() {
  phase_promotion_gate
  banner "Publish to npm"
  run "$RUNNER" pnpm publish --tag latest --access public
  run "$RUNNER" npm view @steipete/oracle version
  run "$RUNNER" npm view @steipete/oracle time
}

phase_smoke() {
  banner "Smoke test in empty dir"
  local tmp=/tmp/oracle-empty
  rm -rf "$tmp" && mkdir -p "$tmp"
  ( cd "$tmp" && npx -y @steipete/oracle@"$VERSION" "Smoke from empty dir" --dry-run )
}

phase_tag() {
  banner "Tag and push"
  git tag "v${VERSION}"
  git push --tags
}

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [phase]

Phases (run individually or all):
  gates           pnpm check, lint, test, build, promotion evidence gate
  promotion-gate  verify release evidence without publishing
  artifacts       npm pack + sha1/sha256
  publish         promotion gate, then pnpm publish and verify npm view
  smoke           empty-dir npx @steipete/oracle@<version> --dry-run
  tag             git tag v<version> && push tags
  all             run everything in order

Environment:
  MCP_RUNNER (default ./runner) - guardrail wrapper
  VERSION    (default from package.json)
EOF
}

main() {
  case "$phase" in
    gates) phase_gates ;;
    promotion-gate) phase_promotion_gate ;;
    artifacts) phase_artifacts ;;
    publish) phase_publish ;;
    smoke) phase_smoke ;;
    tag) phase_tag ;;
    all) phase_gates; phase_artifacts; phase_publish; phase_smoke; phase_tag ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
