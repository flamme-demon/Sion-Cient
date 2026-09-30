import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Le composant Kotlin de `rustls-platform-verifier` doit avoir EXACTEMENT la
// version de la crate `rustls-platform-verifier-android` du Cargo.lock.
val rustlsPlatformVerifierVersion: String = rootProject.file("../../Cargo.lock").readLines().let { lignes ->
    val i = lignes.indexOfFirst { it.trim() == "name = \"rustls-platform-verifier-android\"" }
    require(i >= 0) { "rustls-platform-verifier-android absent du Cargo.lock" }
    lignes[i + 1].substringAfter('"').substringBefore('"')
}

// Clé de signature des APK publiés (celle des 1.x, sinon Android refuse la
// mise à jour) : variables d'environnement en CI (secrets GitHub, voir
// release.yml), sinon `keystore.properties` sur la machine de Grégory.
val cleSignature: Map<String, String>? = System.getenv("SION_KEYSTORE_FILE")?.let { fichier ->
    mapOf(
        "storeFile" to fichier,
        "storePassword" to System.getenv("SION_KEYSTORE_PASSWORD").orEmpty(),
        "keyAlias" to System.getenv("SION_KEY_ALIAS").orEmpty(),
        "keyPassword" to System.getenv("SION_KEY_PASSWORD").orEmpty(),
    )
} ?: rootProject.file("keystore.properties").takeIf { it.exists() }?.let { f ->
    val p = Properties().apply { f.inputStream().use { load(it) } }
    listOf("storeFile", "storePassword", "keyAlias", "keyPassword").associateWith { p.getProperty(it).orEmpty() }
}

android {
    compileSdk = 36
    // NDK de build-android.sh et de la CI (release.yml) : sans lui, AGP ne
    // savait pas stripper la bibliothèque native (« Unable to strip ») et
    // la publiait avec ses 51 Mo de symboles.
    ndkVersion = "27.2.12479018"
    namespace = "com.sion.client"

    signingConfigs {
        create("release") {
            cleSignature?.let { cle ->
                storeFile = file(cle.getValue("storeFile"))
                storePassword = cle.getValue("storePassword")
                keyAlias = cle.getValue("keyAlias")
                keyPassword = cle.getValue("keyPassword")
            }
        }
    }

    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.sion.client"
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".dev"
            // Installable à côté de la version publiée : l'identifiant prend
            // le suffixe `.dev` (bundle.android.debugApplicationIdSuffix dans
            // tauri.conf.json — Tauri efface un applicationIdSuffix écrit ici).
            versionNameSuffix = "-dev"
            // Deux icônes « Sion » sur le téléphone sinon.
            resValue("string", "app_name", "Sion Dev")
            resValue("string", "main_activity_title", "Sion Dev")
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (System.getenv("SION_ESSAI_RELEASE") == "1") {
                // Essai local de la version de publication (R8 compris),
                // installable à côté de la version publiée et de Sion Dev :
                // `SION_ESSAI_RELEASE=1 build-android.sh build`.
                applicationIdSuffix = ".essai"
                versionNameSuffix = "-essai"
                resValue("string", "app_name", "Sion Essai")
                resValue("string", "main_activity_title", "Sion Essai")
                signingConfig = signingConfigs.getByName("debug")
            } else if (cleSignature != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// Version de publication seulement : la bibliothèque native part SANS ses
// symboles et COMPRESSÉE dans l'APK (30/09 : 156 Mo, dont 51 Mo de noms de
// fonctions ; ~43 Mo ainsi). Le gabarit de Tauri garde les symboles via
// `packaging` dans le bloc « debug », ce qui vaut en fait pour toutes les
// variantes : on le défait ici pour la release. Compressée, la bibliothèque
// est décompressée à l'installation (un peu plus de place sur le téléphone,
// bien moins à télécharger). La version complète, pour lire un plantage
// natif, est gardée par la CI (artefact `android-symboles`).
androidComponents {
    onVariants(selector().withBuildType("release")) { variante ->
        variante.packaging.jniLibs.keepDebugSymbols.set(emptySet())
        variante.packaging.jniLibs.useLegacyPackaging.set(true)
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.media:media:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    // Classes Java de WebRTC (micro, haut-parleur) : tirées de l'archive
    // libwebrtc précompilée par build-scripts/build-android.sh.
    implementation(files("libs/libwebrtc.jar"))
    implementation("org.rustls:rustls-platform-verifier:$rustlsPlatformVerifierVersion")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")