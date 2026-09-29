package com.sion.client

import android.content.Context

/**
 * Initialisations natives à faire avant que Tauri ne démarre : vérification
 * TLS du système pour le moteur Matrix, classes Java de WebRTC pour la voix
 * (voir `src-tauri/src/android_natif.rs`).
 */
object SionNatif {
  init {
    System.loadLibrary("app_lib")
  }

  @JvmStatic
  external fun initialiser(context: Context)
}
