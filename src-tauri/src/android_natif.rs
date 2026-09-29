//! Initialisations Java d'Android, appelées par `SionNatif.initialiser`
//! (Kotlin) au tout début de `MainActivity.onCreate`, avant que Tauri ne
//! démarre quoi que ce soit (docs/plan-android-2.1.md, étapes A0 et A2).
//!
//! - **TLS** : `matrix-sdk` (reqwest 0.13) vérifie les certificats avec le
//!   magasin du système par `rustls-platform-verifier`, qui passe par un petit
//!   composant Kotlin (dépendance Gradle `org.rustls:rustls-platform-verifier`)
//!   et doit être initialisé avant la première requête : sans lui, aucune
//!   connexion au serveur Matrix n'aboutit.
//! - **WebRTC** : micro et haut-parleur passent par les classes Java de
//!   libwebrtc (`libwebrtc.jar`), qui veulent la JavaVM et le Context de
//!   l'appli.

use std::sync::Mutex;

use jni::objects::{JClass, JObject};
use jni::JNIEnv;

/// L'initialisation précède le journal de Tauri : ses messages attendent ici
/// que `journaliser_initialisation` les écrive.
static RAPPORT: Mutex<Vec<(log::Level, String)>> = Mutex::new(Vec::new());

fn noter(niveau: log::Level, message: String) {
    RAPPORT.lock().unwrap_or_else(|e| e.into_inner()).push((niveau, message));
}

/// Écrit dans le journal ce que l'initialisation a noté (appelé une fois le
/// journal de Tauri installé).
pub fn journaliser_initialisation() {
    for (niveau, message) in RAPPORT.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
        log::log!(niveau, "{message}");
    }
}

#[no_mangle]
pub extern "system" fn Java_com_sion_client_SionNatif_initialiser<'local>(
    env: JNIEnv<'local>,
    _classe: JClass<'local>,
    contexte: JObject<'local>,
) {
    initialiser_tls(&env, &contexte);
    #[cfg(feature = "native-voice")]
    initialiser_webrtc(&env, &contexte);
}

fn initialiser_tls(env: &JNIEnv, contexte: &JObject) {
    // `rustls-platform-verifier` parle jni 0.22, Tauri et libwebrtc jni 0.21 :
    // le même JNIEnv, repris par son pointeur brut.
    let mut env22 = unsafe { jni22::EnvUnowned::from_raw(env.get_raw().cast()) };
    let brut = contexte.as_raw();
    let issue = env22
        .with_env(|e| -> Result<(), jni22::errors::Error> {
            let ctx = unsafe { jni22::objects::JObject::from_raw(e, brut.cast()) };
            rustls_platform_verifier::android::init_with_env(e, ctx)
        })
        .into_outcome();
    match issue {
        jni22::Outcome::Ok(()) => noter(log::Level::Info, "[Sion][android] vérification TLS du système prête".into()),
        jni22::Outcome::Err(e) => noter(log::Level::Error, format!("[Sion][android] vérification TLS indisponible : {e}")),
        jni22::Outcome::Panic(_) => noter(log::Level::Error, "[Sion][android] vérification TLS : panique à l'initialisation".into()),
    }
}

#[cfg(feature = "native-voice")]
fn initialiser_webrtc(env: &JNIEnv, contexte: &JObject) {
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(e) => {
            noter(log::Level::Error, format!("[Sion][android] WebRTC : JavaVM introuvable : {e}"));
            return;
        }
    };
    if livekit::webrtc::android::initialize_android_context(&vm, contexte) {
        noter(log::Level::Info, "[Sion][android] WebRTC initialisé (micro et haut-parleur Java)".into());
    } else {
        noter(log::Level::Error, "[Sion][android] WebRTC : initialisation du Context refusée".into());
    }
}

/// Appli tuée (tâche retirée des récentes) : `VoiceCallService.onTaskRemoved`
/// appelle ceci avant de s'arrêter. Sans ça, la voix continuait sans
/// interface — « Quitter » de la notification ne répondait plus — et les
/// autres voyaient un participant fantôme (29/09).
#[no_mangle]
pub extern "system" fn Java_com_sion_client_SionNatif_quitterVoix<'local>(_env: JNIEnv<'local>, _classe: JClass<'local>) {
    log::info!("[Sion][android] appli fermée : départ de l'appel");
    // D'abord l'appartenance MatrixRTC (les autres ne nous voient plus),
    // puis la session LiveKit (départ propre au SFU).
    crate::matrix_pont::quitter_voix_bloquant(std::time::Duration::from_millis(1500));
    crate::voice_native::couper_voix_native();
}
