import { useId, useState } from "react";
import type { CatalogModel } from "../lib/types";
import { formatCostFactor } from "../lib/models";

interface Props {
  models: CatalogModel[];
  defaultAlias: string;
  busy?: boolean;
  onConfirm: (alias: string) => void;
  onCancel?: () => void;
}

export function ModelSelector({ models, defaultAlias, busy = false, onConfirm, onCancel }: Props) {
  const available = models.filter((m) => m.available !== false);
  const initial = available.some((m) => m.alias === defaultAlias) ? defaultAlias : (available[0]?.alias ?? "");
  const [alias, setAlias] = useState(initial);
  const groupId = useId();

  return (
    <form
      className="model-selector"
      onSubmit={(e) => {
        e.preventDefault();
        if (alias) onConfirm(alias);
      }}
    >
      <h2 id={`${groupId}-title`}>New conversation</h2>
      <p className="muted">
        Choose a model. It stays fixed for the entire conversation; relative cost is shown against the least expensive option.
      </p>
      <fieldset className="model-options" aria-labelledby={`${groupId}-title`}>
        <legend className="visually-hidden">Model</legend>
        {available.map((m) => {
          const id = `${groupId}-${m.alias}`;
          return (
            <label key={m.alias} htmlFor={id} className={`model-option${alias === m.alias ? " selected" : ""}`}>
              <input
                type="radio"
                id={id}
                name={`${groupId}-model`}
                value={m.alias}
                checked={alias === m.alias}
                onChange={() => setAlias(m.alias)}
              />
              <span className="model-option-body">
                <span className="model-option-head">
                  <span className="model-option-label">{m.label}</span>
                  <span className="badge badge-cost" aria-label={`Relative cost ${formatCostFactor(m.costFactor)}`}>
                    {formatCostFactor(m.costFactor)}
                  </span>
                </span>
                <span className="model-option-desc">{m.description}</span>
              </span>
            </label>
          );
        })}
        {available.length === 0 && <p role="alert">No models are available for your role.</p>}
      </fieldset>
      <div className="row gap">
        <button type="submit" className="btn btn-primary" disabled={busy || !alias}>
          {busy ? "Creating…" : "Start"}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
