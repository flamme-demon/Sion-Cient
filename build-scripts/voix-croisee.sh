#!/usr/bin/env bash
# La voix entre le moteur JS et le moteur Rust, sur un VRAI compte (étape 3,
# docs/plan-matrix-rust-sdk.md) : le vrai MatrixRTCSession de matrix-js-sdk
# et le cœur Rust rejoignent l'appel du salon de test ; appartenances lues de
# part et d'autre, clés échangées sous les identités LiveKit, jeton du
# serveur média vérifié. Aucun média n'est ouvert ; les deux appareils sont
# supprimés à la fin.
#
#   SION_TEST_SERVEUR=… SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
#     ./build-scripts/voix-croisee.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SION_TEST_SERVEUR:?}" "${SION_TEST_IDENTIFIANT:?}" "${SION_TEST_MOT_DE_PASSE:?}"
echange=$(mktemp -d)
trap 'rm -rf "$echange"' EXIT
export SION_TEST_ECHANGE=$echange

(cd src-tauri && cargo test -q -j4 -p sion-matrix --test voix_croisee --no-run 2>/dev/null)
bunx vitest run src/services/voixCroisee.test.ts >"$echange/js.log" 2>&1 &
pid_js=$!
code_rust=0
(cd src-tauri && RUST_LOG=off cargo test -q -j4 -p sion-matrix --test voix_croisee -- --ignored --nocapture) || code_rust=$?
code_js=0
wait "$pid_js" || code_js=$?
if [[ $code_js -ne 0 ]]; then
  echo "── sortie du moteur JS"
  grep -vE "ExperimentalWarning|trace-warnings" "$echange/js.log" | tail -40
fi
echo "Rust : $([[ $code_rust -eq 0 ]] && echo ok || echo "ÉCHEC ($code_rust)") — JS : $([[ $code_js -eq 0 ]] && echo ok || echo "ÉCHEC ($code_js)")"
[[ $code_rust -eq 0 && $code_js -eq 0 ]]
