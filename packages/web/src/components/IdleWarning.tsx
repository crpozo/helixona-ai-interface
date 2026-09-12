import { useEffect, useRef } from "react";

interface Props {
  secondsLeft: number;
  onContinue: () => void;
  onLogout: () => void;
}

export function IdleWarning({ secondsLeft, onContinue, onLogout }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btnRef.current?.focus();
  }, []);
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-desc">
        <h2 id="idle-title">Tu sesión se cerrará por inactividad</h2>
        <p id="idle-desc">
          Se cerrará en <strong aria-live="polite">{mm}:{ss}</strong>. ¿Quieres continuar?
        </p>
        <div className="row gap">
          <button ref={btnRef} type="button" className="btn btn-primary" onClick={onContinue}>
            Seguir conectado
          </button>
          <button type="button" className="btn" onClick={onLogout}>
            Cerrar sesión ahora
          </button>
        </div>
      </div>
    </div>
  );
}
