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
        <h2 id="idle-title">Your session is about to expire due to inactivity</h2>
        <p id="idle-desc">
          You will be signed out in <strong aria-live="polite">{mm}:{ss}</strong>. Do you want to stay signed in?
        </p>
        <div className="row gap">
          <button ref={btnRef} type="button" className="btn btn-primary" onClick={onContinue}>
            Stay signed in
          </button>
          <button type="button" className="btn" onClick={onLogout}>
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}
