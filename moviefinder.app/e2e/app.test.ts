import { test, expect } from "@playwright/test";

test.describe("Moviefinder App", () => {
  test("should mount and load correctly", async ({ page }) => {
    // Navigate to the app
    await page.goto("/");

    // Wait for the page to load
    await page.waitForLoadState("networkidle");

    // Verify page title
    await expect(page).toHaveTitle(/Bun \+ React/);

    // Verify root element exists and has content
    const root = page.locator("#root");
    await expect(root).toBeVisible();

    // Verify the main heading is visible
    const heading = page.getByRole("heading", { name: "Bun + React" });
    await expect(heading).toBeVisible();

    // Verify the app has rendered content (check for the description text)
    const description = page.getByText(/Edit.*src\/App\.tsx.*and save to test HMR/);
    await expect(description).toBeVisible();
  });
});
