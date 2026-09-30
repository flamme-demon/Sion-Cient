#!/usr/bin/env bash
# Vérifie la clé de signature des APK Android, sans rien construire :
#   1. le mot de passe ouvre le keystore ;
#   2. l'alias existe (seule clé privée du keystore si non précisé) ;
#   3. la clé se déverrouille (signature d'un fichier d'essai) ;
#   4. c'est bien la clé des APK publiés — sinon Android refuserait d'installer
#      la nouvelle version par-dessus l'ancienne.
#
# En local (les mots de passe manquants sont demandés, sans écho) :
#   ./build-scripts/verifier-cle-android.sh [sion-release.keystore]
# En CI : SION_KEYSTORE_FILE, SION_KEYSTORE_PASSWORD, SION_KEY_ALIAS,
# SION_KEY_PASSWORD (facultatif : celui du keystore par défaut).
set -euo pipefail

ATTENDU="${SION_CERTIFICAT_ATTENDU:-1b43b5f11f07ba1560ffc6929c325c8909ebe4ec25bd7859fb20cbec503fce1e}"
FICHIER="${1:-${SION_KEYSTORE_FILE:-sion-release.keystore}}"

echec() { echo "✗ $*" >&2; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"; exit 1; }

[ -s "$FICHIER" ] || echec "keystore introuvable ou vide : $FICHIER"
if [ -z "${SION_KEYSTORE_PASSWORD:-}" ]; then
    [ -t 0 ] || echec "SION_KEYSTORE_PASSWORD absent"
    read -rsp "Mot de passe du keystore : " SION_KEYSTORE_PASSWORD; echo
fi
export SION_KEYSTORE_PASSWORD

# 1. Le keystore s'ouvre.
LISTE=$(keytool -list -keystore "$FICHIER" -storepass:env SION_KEYSTORE_PASSWORD 2>&1) \
    || echec "le keystore ne s'ouvre pas : mot de passe faux, ou fichier abîmé (base64 mal copié ?)"
echo "✓ mot de passe du keystore"

# 2. L'alias : celui donné, sinon l'unique clé privée.
if [ -z "${SION_KEY_ALIAS:-}" ]; then
    mapfile -t CLES < <(printf '%s\n' "$LISTE" | grep -i "PrivateKeyEntry" | cut -d, -f1)
    [ "${#CLES[@]}" -eq 1 ] || echec "préciser SION_KEY_ALIAS parmi : ${CLES[*]:-aucune clé privée}"
    SION_KEY_ALIAS="${CLES[0]}"
fi
keytool -list -keystore "$FICHIER" -storepass:env SION_KEYSTORE_PASSWORD -alias "$SION_KEY_ALIAS" >/dev/null 2>&1 \
    || echec "alias « $SION_KEY_ALIAS » absent du keystore"
echo "✓ alias : $SION_KEY_ALIAS"
# En CI : l'alias (pas un secret) pour les étapes suivantes.
[ -n "${GITHUB_ENV:-}" ] && echo "SION_KEY_ALIAS=$SION_KEY_ALIAS" >> "$GITHUB_ENV"

# 3. La clé se déverrouille : on signe un fichier d'essai.
export SION_KEY_PASSWORD="${SION_KEY_PASSWORD:-$SION_KEYSTORE_PASSWORD}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo essai > "$TMP/essai.txt"
(cd "$TMP" && jar cf essai.jar essai.txt)
jarsigner -keystore "$FICHIER" -storepass:env SION_KEYSTORE_PASSWORD -keypass:env SION_KEY_PASSWORD \
    -signedjar "$TMP/signe.jar" "$TMP/essai.jar" "$SION_KEY_ALIAS" >/dev/null 2>&1 \
    || echec "la clé ne se déverrouille pas : mot de passe de la clé (SION_KEY_PASSWORD) faux"
echo "✓ mot de passe de la clé (signature d'essai)"

# 4. Le certificat est celui des APK publiés (1.x comprise).
CERT=$(keytool -exportcert -rfc -keystore "$FICHIER" -storepass:env SION_KEYSTORE_PASSWORD -alias "$SION_KEY_ALIAS" 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')
[ "$CERT" = "$ATTENDU" ] || echec "autre clé que celle des APK publiés : $CERT (attendu $ATTENDU)"
echo "✓ certificat des APK publiés (${CERT:0:8}…${CERT: -8})"
echo "Clé de signature valide."
