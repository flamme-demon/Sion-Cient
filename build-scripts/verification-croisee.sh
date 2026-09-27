#!/usr/bin/env bash
# Vérification par emojis entre le moteur JS et le moteur Rust, sur un VRAI
# compte (le cas de la migration, docs/plan-matrix-rust-sdk.md) : un appareil
# JS vérifié par la clé de récupération accepte la demande d'un NOUVEL
# appareil Rust ; mêmes emojis, confirmation, et l'appareil Rust relit
# l'historique chiffré. Les deux appareils sont supprimés à la fin.
#
# Aucun autre appareil du compte ne doit tourner : chacun accepterait la
# demande, et celui qui n'est pas retenu est annulé.
#
#   SION_TEST_SERVEUR=… SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
#   SION_TEST_CLE_RECUPERATION=… ./build-scripts/verification-croisee.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SION_TEST_SERVEUR:?}" "${SION_TEST_IDENTIFIANT:?}" "${SION_TEST_MOT_DE_PASSE:?}" "${SION_TEST_CLE_RECUPERATION:?}"
echange=$(mktemp -d)
trap 'rm -rf "$echange"' EXIT
export SION_TEST_ECHANGE=$echange

(cd src-tauri && cargo test -q -j4 -p sion-matrix --test verification_croisee --no-run 2>/dev/null)
bunx vitest run src/services/verificationCroisee.test.ts >"$echange/js.log" 2>&1 &
pid_js=$!
code_rust=0
(cd src-tauri && RUST_LOG=off cargo test -q -j4 -p sion-matrix --test verification_croisee -- --ignored --nocapture) || code_rust=$?
code_js=0
wait "$pid_js" || code_js=$?
if [[ $code_js -ne 0 ]]; then
  echo "── sortie du moteur JS"
  grep -vE "ExperimentalWarning|trace-warnings" "$echange/js.log" | tail -40
fi
echo "Rust : $([[ $code_rust -eq 0 ]] && echo ok || echo "ÉCHEC ($code_rust)") — JS : $([[ $code_js -eq 0 ]] && echo ok || echo "ÉCHEC ($code_js)")"
[[ $code_rust -eq 0 && $code_js -eq 0 ]]
