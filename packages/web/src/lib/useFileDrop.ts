import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Turns an element into a file drop target (like dropping a document onto a Claude.ai chat).
 * Returns whether files are currently being dragged over it, so the caller can show an overlay.
 * Nested dragenter/dragleave pairs are counted so the overlay does not flicker over child
 * elements. Drops anywhere else on the page are cancelled so the browser never navigates away
 * to display the dropped file.
 */
export function useFileDrop(ref: RefObject<HTMLElement | null>, onFiles: (files: FileList) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const callback = useRef(onFiles);
  callback.current = onFiles;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (e.dataTransfer && e.dataTransfer.files.length > 0) callback.current(e.dataTransfer.files);
    };
    const cancelOutside = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    el.addEventListener("dragenter", enter);
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    window.addEventListener("dragover", cancelOutside);
    window.addEventListener("drop", cancelOutside);
    return () => {
      el.removeEventListener("dragenter", enter);
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
      window.removeEventListener("dragover", cancelOutside);
      window.removeEventListener("drop", cancelOutside);
      depth.current = 0;
      setDragging(false);
    };
  }, [ref, enabled]);

  return dragging;
}
