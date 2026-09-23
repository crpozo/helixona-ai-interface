import { expect, test } from "@playwright/test";
import { devLogin, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Shared projects", () => {
  test("two accounts work in one project: members come from the directory, everyone sees the same chats and who wrote what", async ({ browser }) => {
    test.setTimeout(90_000);
    const owner = uniqueUser("e2e-owner");
    const member = uniqueUser("e2e-member");
    // The colleague has signed in before, so the directory knows them.
    const memberCtx = await browser.newContext();
    await devLogin(memberCtx, member, "staff");
    await skipTraining(memberCtx);

    const ownerCtx = await browser.newContext();
    await devLogin(ownerCtx, owner, "staff");
    await skipTraining(ownerCtx);
    const page = await ownerCtx.newPage();
    const errs = watchErrors(page);
    await page.goto("/", { waitUntil: "load" });

    // A shared project from the section's own "+".
    await expect(page.getByText("No shared projects yet.")).toBeVisible();
    await page.getByRole("button", { name: "New shared project" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New shared project" })).toBeVisible();
    await expect(page.locator(".project-head .badge")).toHaveText("Shared · 1 person");
    await page.locator("#proj-name").fill("Front desk");
    await page.locator("form:has(#proj-name)").getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.locator(".shared-project-list .project-select")).toContainText("Front desk");
    await expect(page.locator(".project-list:not(.shared-project-list) .project-select")).toHaveCount(0);

    // Members: the colleague is found by name in the directory and added.
    const members = page.locator("section:has(#proj-members-h)");
    await expect(members).toContainText("You · owner");
    await members.getByRole("button", { name: "Add people" }).click();
    await members.getByPlaceholder("Search by name or email").fill(member.slice(0, 14));
    await members.getByRole("button", { name: `Add ${member}` }).click();
    await expect(members.locator(".member-row", { hasText: member })).toBeVisible();
    await expect(members.getByRole("button", { name: `Add ${member}` })).toHaveCount(0);
    await members.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".project-head .badge")).toHaveText("Shared · 2 people");
    await expect(page.locator(".shared-project-list .side-tag")).toHaveText("2 people");

    // The owner starts a chat in it.
    await page.getByPlaceholder("How can I help you today?").fill("Owner's first question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await expect(page.locator(".chat-head")).toContainText(`started by ${owner}`);
    await expect(page.locator(".msg-user .msg-author")).toHaveText(owner);

    // The colleague sees the project, the chat and who wrote it, and continues the conversation.
    const other = await memberCtx.newPage();
    const errs2 = watchErrors(other);
    await other.goto("/", { waitUntil: "load" });
    await expect(other.locator(".shared-project-list .project-select")).toContainText("Front desk");
    await other.locator(".shared-project-list .project-select").click();
    await expect(other.getByRole("heading", { level: 1, name: "Front desk" })).toBeVisible();
    const otherMembers = other.locator("section:has(#proj-members-h)");
    await expect(otherMembers).toContainText(`${member} (you)`);
    await expect(otherMembers.getByRole("button", { name: "Add people" })).toHaveCount(0);
    await expect(other.locator("#proj-visibility")).toBeDisabled();
    await expect(other.getByRole("button", { name: "Delete project" })).toHaveCount(0);
    await expect(other.locator(".project-recents")).toContainText(`started by ${owner}`);
    await other.locator(".recent-row").first().click();
    await expect(other.locator(".msg-user")).toHaveCount(1);
    await expect(other.locator(".msg-user .msg-author")).toHaveText(owner);
    await other.locator("#composer-text").fill("Colleague's follow-up");
    await other.keyboard.press("Enter");
    await expect(other.locator(".msg-assistant")).toHaveCount(2);
    await expect(other.locator(".composer-stop")).toHaveCount(0);
    await expect(other.locator(".msg-user .msg-author").nth(1)).toHaveText(member);

    // The owner's screen picks up the colleague's turn on its own (the open chat is refreshed while idle).
    await expect(page.locator(".msg-user")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(".msg-user .msg-author").nth(1)).toHaveText(member);
    await expect(page.locator(".msg-assistant")).toHaveCount(2);

    // Removing the colleague takes the project, and its chats, away from them.
    await page.locator(".chat-head .badge-project").click();
    page.once("dialog", (d) => void d.accept());
    await members.getByRole("button", { name: `Remove ${member}` }).click();
    await expect(members.locator(".member-row", { hasText: member })).toHaveCount(0);
    await other.goto("/", { waitUntil: "load" });
    await expect(other.getByText("No shared projects yet.")).toBeVisible();
    await expect(other.locator(".conv-list .conv-row")).toHaveCount(0);
    await expect(other.locator(".home-start")).toBeVisible();

    errs.expectNone();
    errs2.expectNone();
    await memberCtx.close();
    await ownerCtx.close();
  });
});
