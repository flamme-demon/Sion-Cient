//! Notifications système des messages, adressées directement au serveur de
//! notifications du bureau Linux (D-Bus `org.freedesktop.Notifications`).
//!
//! Pourquoi pas `tauri-plugin-notification` sous Linux : il ignore les
//! boutons (« Répondre », « Ouvrir ») et le clic, et `notify-rust` envoyait la
//! notification par une connexion D-Bus ouverte puis refermée aussitôt — KDE,
//! voyant l'expéditeur disparaître, la retirait sans la garder dans
//! l'historique (28/09). Ici, UNE connexion vit autant que Sion : la
//! notification expire normalement (et reste dans l'historique), et ses
//! actions nous reviennent :
//! - clic ou « Ouvrir » : Sion revient au premier plan sur le message
//!   (`notification-ouvrir`) ;
//! - « Répondre » : réponse intégrée de KDE (`inline-reply`) ; le texte revient
//!   à l'interface (`notification-repondre`), qui l'envoie comme une réponse
//!   ordinaire — chiffrée si le salon l'est.
//!
//! Hors Linux, la commande échoue et l'interface retombe sur le module de
//! Tauri.

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex, OnceLock};

    use futures_util::StreamExt;
    use serde::Serialize;
    use tauri::{AppHandle, Emitter, Manager};
    use zbus::zvariant::Value;

    use crate::TauriRuntime;

    #[zbus::proxy(
        interface = "org.freedesktop.Notifications",
        default_service = "org.freedesktop.Notifications",
        default_path = "/org/freedesktop/Notifications"
    )]
    trait Notifications {
        #[allow(clippy::too_many_arguments)]
        fn notify(
            &self,
            app_name: &str,
            replaces_id: u32,
            app_icon: &str,
            summary: &str,
            body: &str,
            actions: &[&str],
            hints: HashMap<&str, Value<'_>>,
            expire_timeout: i32,
        ) -> zbus::Result<u32>;

        fn get_capabilities(&self) -> zbus::Result<Vec<String>>;

        #[zbus(signal)]
        fn action_invoked(&self, id: u32, action_key: String) -> zbus::Result<()>;

        /// KDE : texte saisi dans la réponse intégrée.
        #[zbus(signal)]
        fn notification_replied(&self, id: u32, text: String) -> zbus::Result<()>;

    }

    /// Le message auquel une notification renvoie.
    #[derive(Clone, Serialize)]
    struct Cible {
        salon: String,
        evenement: Option<String>,
    }

    /// Notifications dont on se souvient, au plus : une notification expirée
    /// reste dans l'historique de KDE, où l'on peut encore cliquer ou
    /// répondre — on ne l'oublie donc pas à sa fermeture (28/09 : réponse
    /// depuis l'historique ignorée), seulement quand elle est trop ancienne.
    const CIBLES_MAX: usize = 500;

    #[derive(Default)]
    struct Cibles {
        par_id: HashMap<u32, Cible>,
        ordre: VecDeque<u32>,
    }

    impl Cibles {
        fn noter(&mut self, id: u32, cible: Cible) {
            if self.par_id.insert(id, cible).is_none() {
                self.ordre.push_back(id);
            }
            while self.ordre.len() > CIBLES_MAX {
                if let Some(ancien) = self.ordre.pop_front() {
                    self.par_id.remove(&ancien);
                }
            }
        }

        fn cible(&self, id: u32) -> Option<Cible> {
            self.par_id.get(&id).cloned()
        }
    }

    struct Service {
        proxy: NotificationsProxy<'static>,
        /// Le serveur sait afficher un champ de réponse (KDE Plasma).
        reponse_integree: bool,
        icone: String,
        cibles: Mutex<Cibles>,
    }

    static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

    /// Le service, connecté une fois ; ses écouteurs vivent autant que Sion.
    async fn service(app: &AppHandle<TauriRuntime>) -> Result<Arc<Service>, String> {
        if let Some(s) = SERVICE.get() {
            return Ok(s.clone());
        }
        let connexion = zbus::Connection::session().await.map_err(|e| format!("bus de session : {e}"))?;
        let proxy = NotificationsProxy::new(&connexion).await.map_err(|e| format!("serveur de notifications : {e}"))?;
        let capacites = proxy.get_capabilities().await.unwrap_or_default();
        let reponse_integree = capacites.iter().any(|c| c == "inline-reply");
        let icone = icone(app).unwrap_or_default();
        let nouveau = Arc::new(Service { proxy, reponse_integree, icone, cibles: Mutex::new(Cibles::default()) });
        if SERVICE.set(nouveau.clone()).is_ok() {
            log::info!(
                "[Sion][notif] serveur de notifications joint (réponse intégrée : {reponse_integree}, capacités : {})",
                capacites.join(", ")
            );
            ecouter(app.clone(), nouveau);
        }
        Ok(SERVICE.get().expect("service posé juste au-dessus").clone())
    }

    /// Icône de Sion, écrite une fois dans le cache : le serveur de
    /// notifications veut un chemin de fichier (ou un nom d'icône installé).
    fn icone(app: &AppHandle<TauriRuntime>) -> Option<String> {
        let dossier = app.path().app_cache_dir().ok()?;
        std::fs::create_dir_all(&dossier).ok()?;
        let chemin = dossier.join("notification.png");
        if !chemin.exists() {
            std::fs::write(&chemin, include_bytes!("../icons/128x128.png")).ok()?;
        }
        Some(chemin.to_string_lossy().into_owned())
    }

    fn ramener_la_fenetre(app: &AppHandle<TauriRuntime>) {
        if let Some(fenetre) = app.get_webview_window("main") {
            let _ = fenetre.unminimize();
            let _ = fenetre.show();
            let _ = fenetre.set_focus();
        }
    }

    fn ecouter(app: AppHandle<TauriRuntime>, service: Arc<Service>) {
        // Clic, « Ouvrir » — ou « Répondre » sur un serveur sans réponse
        // intégrée (GNOME) : on ouvre le message.
        let (app_action, service_action) = (app.clone(), service.clone());
        tauri::async_runtime::spawn(async move {
            let Ok(mut flux) = service_action.proxy.receive_action_invoked().await else { return };
            while let Some(signal) = flux.next().await {
                let Ok(args) = signal.args() else { continue };
                let cible = service_action.cibles.lock().unwrap().cible(args.id);
                let Some(cible) = cible else {
                    log::debug!("[Sion][notif] action « {} » sur la notification {} (pas de Sion ?)", args.action_key, args.id);
                    continue;
                };
                log::info!("[Sion][notif] action « {} » : ouverture de {}", args.action_key, cible.salon);
                ramener_la_fenetre(&app_action);
                let _ = app_action.emit("notification-ouvrir", &cible);
            }
        });
        // Réponse intégrée (KDE).
        let (app_reponse, service_reponse) = (app.clone(), service.clone());
        tauri::async_runtime::spawn(async move {
            let Ok(mut flux) = service_reponse.proxy.receive_notification_replied().await else { return };
            while let Some(signal) = flux.next().await {
                let Ok(args) = signal.args() else { continue };
                let cible = service_reponse.cibles.lock().unwrap().cible(args.id);
                let Some(cible) = cible else {
                    log::warn!("[Sion][notif] réponse à la notification {} inconnue : ignorée", args.id);
                    continue;
                };
                log::info!("[Sion][notif] réponse depuis la notification vers {}", cible.salon);
                let _ = app_reponse.emit(
                    "notification-repondre",
                    &serde_json::json!({ "salon": cible.salon, "evenement": cible.evenement, "texte": args.text }),
                );
            }
        });
        // La fermeture d'une notification ne l'oublie PAS : expirée, elle
        // reste dans l'historique et peut encore servir (voir `CIBLES_MAX`).
        drop(service);
    }

    pub async fn envoyer(
        app: &AppHandle<TauriRuntime>,
        titre: &str,
        corps: &str,
        salon: String,
        evenement: Option<String>,
    ) -> Result<(), String> {
        let service = service(app).await?;
        let mut actions = vec!["default", "Ouvrir"];
        let mut indices: HashMap<&str, Value<'_>> = HashMap::new();
        // Le serveur rattache la notification à Sion (nom, icône, réglages
        // par application) grâce à son fichier .desktop.
        indices.insert("desktop-entry", Value::from("sion-client"));
        indices.insert("category", Value::from("im.received"));
        indices.insert("urgency", Value::from(1u8));
        if service.reponse_integree {
            actions.extend(["inline-reply", "Répondre"]);
            indices.insert("x-kde-reply-placeholder-text", Value::from("Votre réponse…"));
            indices.insert("x-kde-reply-submit-button-text", Value::from("Envoyer"));
        }
        let id = service
            .proxy
            .notify("Sion", 0, &service.icone, titre, corps, &actions, indices, -1)
            .await
            .map_err(|e| format!("notification refusée : {e}"))?;
        service.cibles.lock().unwrap().noter(id, Cible { salon, evenement });
        Ok(())
    }
}

/// Notification d'un message (voir le module). Hors Linux : erreur, et
/// l'interface retombe sur `tauri-plugin-notification`.
#[tauri::command]
pub async fn notification_message(
    app: tauri::AppHandle<crate::TauriRuntime>,
    titre: String,
    corps: String,
    salon: String,
    evenement: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux::envoyer(&app, &titre, &corps, salon, evenement).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, titre, corps, salon, evenement);
        Err("notifications D-Bus : Linux seulement".into())
    }
}
