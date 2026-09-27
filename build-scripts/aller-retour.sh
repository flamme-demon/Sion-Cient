#!/usr/bin/env bash
# Aller-retour entre le moteur JS et le moteur Rust, sur un VRAI compte
# (critère de T3, docs/plan-matrix-rust-sdk.md). Les deux moteurs tournent EN
# MÊME TEMPS, comme deux appareils du compte, dans un salon de test privé et
# chiffré (« Sion — banc d'essai des moteurs », réutilisé d'un passage à
# l'autre) : chacun envoie une série complète et vérifie celle de l'autre.
# Chaque moteur supprime son appareil à la fin.
#
#   SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
#     ./build-scripts/aller-retour.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SION_TEST_SERVEUR:?}" "${SION_TEST_IDENTIFIANT:?}" "${SION_TEST_MOT_DE_PASSE:?}"
echange=$(mktemp -d)
trap 'rm -rf "$echange"' EXIT
export SION_TEST_ECHANGE=$echange

echo "▶ compilation du côté Rust"
(cd src-tauri && cargo test -q -j4 -p sion-matrix --test aller_retour --no-run 2>/dev/null)

echo "▶ moteurs JS et Rust en parallèle"
bunx vitest run src/services/allerRetour.test.ts >"$echange/js.log" 2>&1 &
pid_js=$!
code_rust=0
(cd src-tauri && RUST_LOG=off cargo test -q -j4 -p sion-matrix --test aller_retour -- --ignored --nocapture) || code_rust=$?
code_js=0
wait "$pid_js" || code_js=$?

if [[ $code_js -ne 0 ]]; then
  echo "── sortie du moteur JS"
  grep -vE "ExperimentalWarning|trace-warnings" "$echange/js.log" | tail -40
fi
echo "Rust : $([[ $code_rust -eq 0 ]] && echo ok || echo "ÉCHEC ($code_rust)") — JS : $([[ $code_js -eq 0 ]] && echo ok || echo "ÉCHEC ($code_js)")"
[[ $code_rust -eq 0 && $code_js -eq 0 ]]
