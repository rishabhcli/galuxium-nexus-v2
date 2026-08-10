import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('truthful admin status', () => {
  test.use({ viewport: { height: 320, width: 375 } });

  test.beforeEach(async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('exposes semantic status content that remains reachable by keyboard', async ({ page }) => {
    await expect(page).toHaveTitle('Development service status');
    const main = page.getByRole('main');
    await expect(main).toBeVisible();
    await expect(
      main.getByRole('heading', { level: 1, name: 'Hard budget control plane' }),
    ).toBeVisible();
    await expect(
      main.getByRole('heading', { level: 2, name: 'Dependency readiness' }),
    ).toBeVisible();
    await expect(main.locator('.notice')).toContainText('Not yet in production.');
    await expect(main.locator('.notice')).toContainText(
      'Budget authorization and ledger workflows are not implemented yet.',
    );
    await expect(main.locator('dt')).toHaveText(['Gateway', 'Reconciler']);
    await expect(main.locator('dd')).toHaveText([
      'dependency check passed',
      'dependency check passed',
    ]);

    const requestId = main.getByText(/^Request ID:/u);
    await page.keyboard.press('End');
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(requestId).toBeInViewport();

    await page.keyboard.press('Home');
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(main.getByRole('heading', { level: 1 })).toBeInViewport();
  });

  test('has no critical or serious axe violations', async ({ page }) => {
    const results = await new AxeBuilder({ page }).analyze();
    const blockingViolations = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );

    expect(
      blockingViolations,
      JSON.stringify(
        blockingViolations.map(({ description, help, id, impact, nodes }) => ({
          description,
          help,
          id,
          impact,
          targets: nodes.map((node) => node.target),
        })),
        undefined,
        2,
      ),
    ).toEqual([]);
  });
});
