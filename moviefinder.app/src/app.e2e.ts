import { expect, test } from "@playwright/test";

test.describe("Moviefinder App", () => {
  test("should mount and load correctly", async ({ page }) => {
    // Navigate to the app
    await page.goto("/");

    // Wait for the page to load
    await page.waitForLoadState("networkidle");

    // Verify page title
    await expect(page).toHaveTitle(/moviefinder\.app/);

    // Verify root element exists and has content
    const root = page.locator("#root");
    await expect(root).toBeVisible();
  });
});
