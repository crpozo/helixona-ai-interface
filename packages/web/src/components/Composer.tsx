import { useEffect, useRef, useState } from "react";

interface Props {
  maxChars: number;
  streaming: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ maxChars, streaming, disabled = false, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();
  const over = text.length > maxChars;
  const canSend = !streaming && !disabled && trimmed.length > 0 && !over;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText("");
    ref.current?.focus();
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="composer-text" className="visually-hidden">
        Mensaje
      </label>
      <textarea
        id="composer-text"
        ref={ref}
        value={text}
        rows={1}
        placeholder="Escribe tu mensaje… (Enter envía, Shift+Enter salto de línea)"
        disabled={disabled}
        aria-invalid={over || undefined}
        aria-describedby="composer-counter"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-bar">
        <span id="composer-counter" className={`counter${over ? " over" : ""}`} aria-live="polite">
          {text.length.toLocaleString("es")} / {maxChars.toLocaleString("es")}
        </span>
        <div className="row gap">
          {streaming && (
            <button type="button" className="btn btn-danger" onClick={onStop}>
              Detener
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!canSend}>
            Enviar
          </button>
        </div>
      </div>
    </form>
  );
}
