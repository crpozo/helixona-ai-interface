import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listUsers: vi.fn(async () => [
    { id: "u1", name: "Ana Perez", email: "ana@clinic.test" },
    { id: "u2", name: "Luis Romero", email: "luis@clinic.test" },
    { id: "u3", name: "Marta Gil", email: "marta@clinic.test" },
  ]),
  addProjectMember: vi.fn(async (_id: string, userId: string) => ({ ...shared, members: [...shared.members, { id: userId, name: "Marta Gil", email: "marta@clinic.test", addedAt: "2026-09-20T00:00:00Z" }] })),
  removeProjectMember: vi.fn(async () => ({ ...shared, members: [] })),
}));

import { addProjectMember, listUsers, removeProjectMember } from "../lib/api";
import { ProjectMembers } from "./ProjectMembers";

const shared: Project = {
  id: "p1",
  ownerId: "u1",
  ownerName: "Ana Perez",
  name: "Front desk",
  description: "",
  instructions: "",
  visibility: "shared",
  members: [{ id: "u2", name: "Luis Romero", email: "luis@clinic.test", addedAt: "2026-09-14T00:00:00Z" }],
  knowledge: [],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  canEdit: true,
  canManage: true,
};

afterEach(cleanup);

describe("ProjectMembers", () => {
  it("lists the owner and the members; the owner picks colleagues from the directory, leaving out who is already in", async () => {
    const onUpdated = vi.fn();
    render(<ProjectMembers project={shared} meId="u1" onUpdated={onUpdated} />);
    expect(screen.getByRole("heading", { name: "Members" })).toBeTruthy();
    expect(screen.getByText(/You/).textContent).toContain("owner");
    expect(screen.getByText("Luis Romero")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    await waitFor(() => expect(listUsers).toHaveBeenCalled());
    // Ana (owner) and Luis (member) are not offered; Marta is.
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Marta Gil" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Add Luis Romero" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Ana Perez" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search by name or email"), { target: { value: "zzz" } });
    expect(screen.getByText("No one matches.")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search by name or email"), { target: { value: "marta@" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Marta Gil" }));
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledWith("p1", "u3"));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ members: expect.arrayContaining([expect.objectContaining({ id: "u3" })]) })));
  });

  it("removes a member after a confirmation", async () => {
    const onUpdated = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ProjectMembers project={shared} meId="u1" onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Luis Romero" }));
    expect(removeProjectMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Luis Romero" }));
    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledWith("p1", "u2"));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ members: [] })));
  });

  it("a member sees the list but no picker or remove buttons; private and clinic projects explain who sees them", () => {
    render(<ProjectMembers project={{ ...shared, canManage: false }} meId="u2" onUpdated={vi.fn()} />);
    expect(screen.getByText("Ana Perez").textContent).toContain("owner");
    expect(screen.getByText("Luis Romero (you)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    cleanup();
    render(<ProjectMembers project={{ ...shared, visibility: "private", members: [] }} meId="u1" onUpdated={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Sharing" })).toBeTruthy();
    expect(screen.getByText(/Only you can see this project/)).toBeTruthy();
    cleanup();
    render(<ProjectMembers project={{ ...shared, visibility: "clinic", members: [] }} meId="u1" onUpdated={vi.fn()} />);
    expect(screen.getByText(/Everyone in the clinic can use/)).toBeTruthy();
  });
});
