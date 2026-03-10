import { useCallback, type DragEvent } from "react";
import { ChatHeader } from "../chat/ChatHeader";
import { PinnedBar } from "../chat/PinnedBar";
import { ScreenShareView } from "../chat/ScreenShareView";
import { MessageList } from "../chat/MessageList";
import { ChatInput } from "../chat/ChatInput";
import { DropZone } from "../chat/DropZone";
import { useAppStore } from "../../stores/useAppStore";
import { useIsMobile } from "../../hooks/useIsMobile";
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

  const needsVoiceBarPadding = isMobile && !!connectedVoice;

  return (
    <div
      className="flex-1 flex flex-col min-w-0 relative"
      style={needsVoiceBarPadding ? { paddingBottom: MOBILE_VOICE_BAR_HEIGHT } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ChatHeader />
      <PinnedBar />
      <ScreenShareView />
      <MessageList />
      <ChatInput />
      <DropZone />
    </div>
  );
}
