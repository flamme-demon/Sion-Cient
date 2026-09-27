#!/usr/bin/env bash
# Migration de l'ancien moteur vers le cœur Rust (étape 4), sur un VRAI
# compte : un appareil matrix-js-sdk vérifié (clé de récupération) exporte
# secrets et clés de salons comme le fera l'appli ; le cœur ouvre un nouvel
# appareil avec cet export, qui doit être vérifié d'emblée. Les deux
# appareils sont supprimés à la fin.
#
#   SION_TEST_SERVEUR=… SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
#   SION_TEST_CLE_RECUPERATION=… ./build-scripts/migration-croisee.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SION_TEST_SERVEUR:?}" "${SION_TEST_IDENTIFIANT:?}" "${SION_TEST_MOT_DE_PASSE:?}" "${SION_TEST_CLE_RECUPERATION:?}"
echange=$(mktemp -d)
trap 'rm -rf "$echange"' EXIT
export SION_TEST_ECHANGE=$echange

(cd src-tauri && cargo test -q -j4 -p sion-matrix --test migration_croisee --no-run 2>/dev/null)
bunx vitest run src/services/migrationCroisee.test.ts >"$echange/js.log" 2>&1 &
pid_js=$!
code_rust=0
(cd src-tauri && RUST_LOG=off cargo test -q -j4 -p sion-matrix --test migration_croisee -- --ignored --nocapture) || code_rust=$?
code_js=0
wait "$pid_js" || code_js=$?
if [[ $code_js -ne 0 ]]; then
  echo "── sortie du moteur JS"
  grep -vE "ExperimentalWarning|trace-warnings" "$echange/js.log" | tail -40
fi
echo "Rust : $([[ $code_rust -eq 0 ]] && echo ok || echo "ÉCHEC ($code_rust)") — JS : $([[ $code_js -eq 0 ]] && echo ok || echo "ÉCHEC ($code_js)")"
[[ $code_rust -eq 0 && $code_js -eq 0 ]]
