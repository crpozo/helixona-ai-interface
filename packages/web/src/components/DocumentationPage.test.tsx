import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DocumentationPage } from "./DocumentationPage";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("DocumentationPage", () => {
  it("lists the three documents with a Word download for each", () => {
    window.history.replaceState(null, "", "/documentation");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "Compliance documents" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HIPAA Security Risk Analysis" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HIPAA Policies and Procedures" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workforce Training" })).toBeTruthy();
    const downloads = screen.getAllByRole("link", { name: "Download Word file" }).map((a) => a.getAttribute("href"));
    expect(downloads).toEqual([
      "/docs/Helixona-Assistant-Risk-Analysis.docx",
      "/docs/Helixona-Assistant-Policies-and-Procedures.docx",
      "/docs/Helixona-Assistant-Workforce-Training.docx",
    ]);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("opens a document from its card and renders its sections, tables and signature block", () => {
    window.history.replaceState(null, "", "/documentation");
    render(<DocumentationPage backLabel="Back to the assistant" backTo="/" />);
    fireEvent.click(screen.getAllByRole("link", { name: "Read online" })[0]!);
    expect(window.location.pathname).toBe("/documentation/risk-analysis");
    expect(screen.getByRole("heading", { level: 1, name: "HIPAA Security Risk Analysis" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "5. Risk register" })).toBeTruthy();
    expect(screen.getByText("Stolen or phished staff password")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Signature" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Contents" }).textContent).toContain("6. Remediation plan");
    expect(screen.getByRole("link", { name: "Download Word file" }).getAttribute("href")).toBe("/docs/Helixona-Assistant-Risk-Analysis.docx");
    expect(screen.getByRole("link", { name: "All documents" })).toBeTruthy();
  });

  it("renders the policies and the training from their URLs", () => {
    window.history.replaceState(null, "", "/documentation/policies-and-procedures");
    const { unmount } = render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "HIPAA Policies and Procedures" })).toBeTruthy();
    unmount();
    window.history.replaceState(null, "", "/documentation/workforce-training");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "Workforce Training" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: /Knowledge check/ })).toBeTruthy();
  });

  it("falls back to the index for an unknown document", () => {
    window.history.replaceState(null, "", "/documentation/does-not-exist");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "Compliance documents" })).toBeTruthy();
  });
});
