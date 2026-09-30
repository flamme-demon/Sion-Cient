# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Appelées depuis le code natif (JNI) : invisibles pour ProGuard.
# La libwebrtc de LiveKit renomme ses paquets sous `livekit.org` (webrtc,
# webrtc.audio, jni_zero) : toute la libwebrtc.jar est appelée par JNI. Sans
# cette règle, R8 les retirait de l'APK de publication et l'appli plantait au
# démarrage (ClassNotFoundException livekit.org.jni_zero.JniZero, 30/09) ;
# l'APK de dev, non minifié, les gardait.
-keep class livekit.org.** { *; }
# Référencée par JniZero.setJniClassLoader mais absente de libwebrtc.jar ;
# jamais chargée (la version de dev, sans R8, a la même jar et la voix marche).
-dontwarn livekit.org.jni_zero.JniZeroJni
-keep class org.webrtc.** { *; }
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
-keep class com.sion.client.SionNatif { *; }
