import { useCallback, useEffect, type DragEvent } from "react";
import { ChatHeader } from "../chat/ChatHeader";
import { PinnedBar } from "../chat/PinnedBar";
import { TranscriptInviteBanner } from "../chat/TranscriptInviteBanner";
import { ScreenShareView } from "../chat/ScreenShareView";
import { MessageList } from "../chat/MessageList";
import { ChatInput } from "../chat/ChatInput";
import { DropZone } from "../chat/DropZone";
import { DockZone } from "./DockZone";
import { useAppStore } from "../../stores/useAppStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import { readDroppedFile } from "../../utils/droppedFile";
import { MOBILE_VOICE_BAR_HEIGHT } from "../mobile/MobileVoiceBar";

export function MainArea() {
  const setDraggingOver = useAppStore((s) => s.setDraggingOver);
  const addPendingFile = useAppStore((s) => s.addPendingFile);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const isMobile = useIsMobile();

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDraggingOver(true);
  }, [setDraggingOver]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDraggingOver(false);
    }
  }, [setDraggingOver]);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDraggingOver(false);
    const files = e.dataTransfer.files;
    for (const file of Array.from(files)) {
      addPendingFile(file);
    }
  }, [setDraggingOver, addPendingFile]);

  // Drag & drop natif Tauri : WebKitGTK ne transmet pas les fichiers déposés
  // au DOM, seuls des chemins arrivent par cet event. Les handlers DOM
  // ci-dessus restent utiles pour les drops de texte.
  useEffect(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!internals) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const fn = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDraggingOver(true);
            return;
          }
          setDraggingOver(false);
          if (payload.type !== "drop") return;
          for (const path of payload.paths) {
            void readDroppedFile(path).then((file) => {
              if (file) void addPendingFile(file);
            });
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (err) {
        console.warn("[Sion] drag & drop natif indisponible:", err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setDraggingOver, addPendingFile]);

  const needsVoiceBarPadding = isMobile && !!connectedVoice;

  return (
    <div
      className="flex-1 flex flex-col min-w-0 relative"
      style={needsVoiceBarPadding ? { paddingBottom: MOBILE_VOICE_BAR_HEIGHT } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex-1 flex min-h-0 min-w-0">
        <div className="flex-1 flex flex-col min-w-0 relative">
          <ChatHeader />
          <PinnedBar />
          <TranscriptInviteBanner />
          <ScreenShareView />
          <MessageList />
          <ChatInput />
          <DropZone />
        </div>
        {!isMobile && <DockZone zone="right" />}
      </div>
      {!isMobile && <DockZone zone="bottom" />}
    </div>
  );
}
