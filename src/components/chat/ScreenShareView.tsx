import { useEffect, useRef, useState } from "react";
import { onScreenShareChange, type ScreenShareInfo } from "../../services/livekitService";
import { useTranslation } from "react-i18next";

export function ScreenShareView() {
  const { t } = useTranslation();
  const [screenShare, setScreenShare] = useState<ScreenShareInfo | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const unsub = onScreenShareChange(setScreenShare);
    return unsub;
  }, []);

  useEffect(() => {
    if (!screenShare || !videoRef.current) return;
    const el = screenShare.track.attach(videoRef.current);
    return () => {
      screenShare.track.detach(el);
    };
  }, [screenShare]);

  if (!screenShare) return null;

  return (
    <div className="bg-black flex flex-col items-center border-b border-[var(--color-border)]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        controls
        controlsList="nodownload noremoteplayback"
        className="w-full max-h-[50vh] object-contain"
      />
      <div className="text-xs text-[var(--color-text-secondary)] py-1">
        {t("screenShare.sharedBy", { name: screenShare.participantName, defaultValue: "{{name}} partage son écran" })}
      </div>
    </div>
  );
}
