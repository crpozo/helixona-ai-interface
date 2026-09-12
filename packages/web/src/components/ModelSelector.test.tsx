import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelSelector } from "./ModelSelector";
import type { CatalogModel } from "../lib/types";

const models: CatalogModel[] = [
  { alias: "sonnet", modelId: "anthropic.claude-sonnet-5", label: "Sonnet", description: "Rápido y económico", costFactor: 1, available: true },
  { alias: "opus", modelId: "anthropic.claude-opus-5", label: "Opus", description: "Equilibrio recomendado", costFactor: 2.5, available: true },
  { alias: "fable", modelId: "anthropic.claude-fable-5-1", label: "Fable", description: "Máxima capacidad", costFactor: 5, available: true },
  { alias: "oculto", modelId: "x", label: "Oculto", description: "no disponible", costFactor: 1, available: false },
];

afterEach(cleanup);

describe("ModelSelector", () => {
  it("muestra los modelos disponibles con descripción y costo, preseleccionando el default", () => {
    render(<ModelSelector models={models} defaultAlias="opus" onConfirm={() => {}} />);
    expect(screen.getByRole("radio", { name: /Opus/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /Sonnet/ })).toHaveProperty("checked", false);
    expect(screen.queryByText("Oculto")).toBeNull();
    expect(screen.getByText("1x")).toBeTruthy();
    expect(screen.getByText("2,5x")).toBeTruthy();
    expect(screen.getByText("5x")).toBeTruthy();
    expect(screen.getByText("Equilibrio recomendado")).toBeTruthy();
  });

  it("confirma con el alias elegido", () => {
    const onConfirm = vi.fn();
    render(<ModelSelector models={models} defaultAlias="opus" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: /Fable/ }));
    fireEvent.click(screen.getByRole("button", { name: "Empezar" }));
    expect(onConfirm).toHaveBeenCalledWith("fable");
  });
});
