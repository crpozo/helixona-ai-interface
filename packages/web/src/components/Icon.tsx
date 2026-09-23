/** Small line icons (stroke = currentColor) so the sidebar and composer read like Claude.ai's, without emoji. */
export type IconName = "bug" | "plus" | "chat" | "folder" | "book" | "cap" | "sliders" | "pencil" | "trash" | "chevron" | "logout" | "arrow-up" | "stop" | "close" | "menu";

const PATHS: Record<IconName, JSX.Element> = {
  bug: <path d="M9 8V6a3 3 0 0 1 6 0v2M8 8h8a4 4 0 0 1 4 4v3a8 8 0 0 1-16 0v-3a4 4 0 0 1 4-4zM12 8v11M4 13H2M22 13h-2M5 19l-2 2M19 19l2 2M6 9 4 7M18 9l2-2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4h-.5A2.5 2.5 0 0 1 2 13.5v-8A2.5 2.5 0 0 1 4.5 3" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  book: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 16.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5.5a1.5 1.5 0 0 0 1.5-1.5z" />,
  cap: <path d="M2.5 9.5 12 5l9.5 4.5L12 14zM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5M21.5 9.5V15" />,
  sliders: <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M6 10v4M16 16v4" />,
  pencil: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z M13.5 6.5l3 3" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  logout: <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l5 4-5 4M20 12H9" />,
  "arrow-up": <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
